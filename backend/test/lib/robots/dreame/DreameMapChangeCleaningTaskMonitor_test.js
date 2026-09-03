const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameMapChangeCleaningTaskMonitor = require("../../../../lib/robots/dreame/DreameMapChangeCleaningTaskMonitor");
const entities = require("../../../../lib/entities");

const stateAttrs = entities.state.attributes;

const makeStatus = (value, flag = stateAttrs.StatusStateAttribute.FLAG.NONE) => {
    return new stateAttrs.StatusStateAttribute({
        value: value,
        flag: flag
    });
};

class FakeRobot {
    constructor(mapId = 64, mapNames = {64: "Lower floor", 68: "Upper floor"}) {
        this.mapId = mapId;
        this.mapNames = mapNames;
        this.mapListeners = [];
        this.events = [];
        this.state = new entities.state.RobotState({
            map: {}
        });
        this.state.upsertFirstMatchingAttribute(makeStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED));
        this.valetudoEventStore = {
            raise: event => {
                this.events.push(event);
            }
        };
    }

    getCurrentDreameSavedMapId() {
        return this.mapId;
    }

    getDreameSavedMapName(mapId) {
        const name = this.mapNames[mapId];

        return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
    }

    onMapUpdated(listener) {
        this.mapListeners.push(listener);
    }

    emitMap(mapId) {
        this.mapId = mapId;
        this.mapListeners.forEach(listener => listener());
    }

    setStatus(value, flag) {
        this.state.upsertFirstMatchingAttribute(makeStatus(value, flag));
    }

    async pollState() {
        return this.state;
    }
}

const makeMonitor = (options = {}) => {
    const robot = options.robot ?? new FakeRobot();
    const calls = [];
    let preferenceEnabled = options.preferenceEnabled ?? true;

    const actions = {
        start: async () => {
            calls.push("start");
            await options.onStart?.(robot);
        },
        stop: async () => {
            calls.push("stop");
            if (options.stopLeavesResumable === true) {
                robot.setStatus(
                    stateAttrs.StatusStateAttribute.VALUE.DOCKED,
                    stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
                );
            } else {
                robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.PAUSED);
            }
            await options.onStop?.(robot);
        },
        home: async () => {
            calls.push("home");
            robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);
            await options.onHome?.(robot);
        }
    };
    const segmentPreferencesApplyControl = {
        isEnabled: async () => {
            calls.push("read_preferences");

            if (options.preferenceReadError) {
                throw options.preferenceReadError;
            }

            if (options.preferenceReadResults?.length > 0) {
                return options.preferenceReadResults.shift();
            }

            return preferenceEnabled;
        },
        enable: async () => {
            calls.push("enable_preferences");

            if (options.preferenceWriteError) {
                throw options.preferenceWriteError;
            }

            await options.onEnablePreferences?.(robot);
            preferenceEnabled = options.preferenceWriteDoesNotApply !== true;
        },
        disable: async () => {
            calls.push("disable_preferences");

            if (options.preferenceWriteError) {
                throw options.preferenceWriteError;
            }

            await options.onDisablePreferences?.(robot);
            preferenceEnabled = options.preferenceWriteDoesNotApply === true;
        }
    };

    const monitor = new DreameMapChangeCleaningTaskMonitor({
        robot: robot,
        actions: actions,
        segmentPreferencesApplyControl: segmentPreferencesApplyControl,
        pollIntervalMs: 0,
        stopTimeoutMs: 50,
        returnToDockTimeoutMs: 50,
        preferenceTimeoutMs: options.preferenceTimeoutMs ?? 10,
        maxFullCleanupMapChanges: options.maxFullCleanupMapChanges ?? 3
    });

    return {monitor: monitor, robot: robot, calls: calls};
};

const startFullAndMarkActive = async (fixture) => {
    await fixture.monitor.startOrResumeFullCleanup();
    fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
};

describe("DreameMapChangeCleaningTaskMonitor", function() {
    it("should capture the firmware preference source before a fresh full cleanup", async function() {
        const fixture = makeMonitor({preferenceEnabled: true});

        await fixture.monitor.startOrResumeFullCleanup();

        assert.deepEqual(fixture.calls, ["read_preferences", "start"]);
        assert.deepEqual(fixture.monitor.getOperation(), {
            kind: "full",
            phase: "awaiting_active",
            mapId: 64,
            targetMapId: undefined,
            segmentPreferencesEnabled: true,
            seenActive: false,
            mapChangeCount: 0
        });
    });

    it("should not START when the initial preference source cannot be read", async function() {
        const readError = new Error("read failed");
        const fixture = makeMonitor({preferenceReadError: readError});

        await assert.rejects(fixture.monitor.startOrResumeFullCleanup(), readError);

        assert.deepEqual(fixture.calls, ["read_preferences"]);
        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should resume without recapturing or replacing full-clean intent", async function() {
        const fixture = makeMonitor({preferenceEnabled: false});
        await startFullAndMarkActive(fixture);
        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.PAUSED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );
        const operationBeforeResume = fixture.monitor.getOperation();

        await fixture.monitor.startOrResumeFullCleanup();

        assert.deepEqual(fixture.calls, ["read_preferences", "start", "start"]);
        assert.deepEqual(fixture.monitor.getOperation(), operationBeforeResume);
    });

    it("should wait for an in-flight resume START before handling a map change", async function() {
        let releaseResumeStart;
        let markResumeStart;
        const resumeStartEntered = new Promise(resolve => {
            markResumeStart = resolve;
        });
        const resumeStartBlocked = new Promise(resolve => {
            releaseResumeStart = resolve;
        });
        const fixture = makeMonitor({
            onStart: async () => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    markResumeStart();
                    await resumeStartBlocked;
                }
            }
        });
        await startFullAndMarkActive(fixture);
        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.PAUSED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );

        const resume = fixture.monitor.startOrResumeFullCleanup();
        await resumeStartEntered;
        fixture.robot.emitMap(68);
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fixture.calls.includes("stop"), false);

        releaseResumeStart();
        await resume;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 3);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.monitor.getOperation().mapId, 68);
    });

    it("should wait for an in-flight resume START before external STOP", async function() {
        let releaseResumeStart;
        let markResumeStart;
        const resumeStartEntered = new Promise(resolve => {
            markResumeStart = resolve;
        });
        const resumeStartBlocked = new Promise(resolve => {
            releaseResumeStart = resolve;
        });
        const fixture = makeMonitor({
            onStart: async () => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    markResumeStart();
                    await resumeStartBlocked;
                }
            }
        });
        await startFullAndMarkActive(fixture);
        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.PAUSED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );

        const resume = fixture.monitor.startOrResumeFullCleanup();
        await resumeStartEntered;
        const stop = fixture.monitor.stop();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fixture.calls.includes("stop"), false);

        releaseResumeStart();
        await Promise.all([resume, stop]);

        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should recover a handling operation when an in-flight resume START fails", async function() {
        let rejectResumeStart;
        let markResumeStart;
        const resumeStartEntered = new Promise(resolve => {
            markResumeStart = resolve;
        });
        const resumeStartFailed = new Promise((resolve, reject) => {
            rejectResumeStart = reject;
        });
        const fixture = makeMonitor({
            onStart: async () => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    markResumeStart();
                    await resumeStartFailed;
                }
            }
        });
        await startFullAndMarkActive(fixture);
        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.PAUSED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );

        const resume = fixture.monitor.startOrResumeFullCleanup();
        await resumeStartEntered;
        fixture.robot.emitMap(68);
        rejectResumeStart(new Error("resume failed"));

        await assert.rejects(resume, /resume failed/);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 3);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.monitor.getOperation().mapId, 68);
    });

    it("should retain monitored intent after a failed resume START", async function() {
        let failResume = true;
        const fixture = makeMonitor({
            onStart: async () => {
                if (fixture.calls.filter(call => call === "start").length === 2 && failResume) {
                    failResume = false;
                    throw new Error("resume failed");
                }
            }
        });
        await startFullAndMarkActive(fixture);
        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.PAUSED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );

        await assert.rejects(fixture.monitor.startOrResumeFullCleanup(), /resume failed/);
        assert.equal(fixture.monitor.getOperation().kind, "full");

        await fixture.monitor.startOrResumeFullCleanup();
        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 4);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.monitor.getOperation().mapId, 68);
    });

    it("should wait for an external STOP before accepting a later START", async function() {
        let releaseStop;
        let markStop;
        const stopEntered = new Promise(resolve => {
            markStop = resolve;
        });
        const stopBlocked = new Promise(resolve => {
            releaseStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                markStop();
                await stopBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        const stop = fixture.monitor.stop();
        await stopEntered;
        const start = fixture.monitor.startOrResumeFullCleanup();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fixture.calls.filter(call => call === "start").length, 1);

        releaseStop();
        await Promise.all([stop, start]);

        assert.equal(fixture.calls.filter(call => call === "start").length, 2);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.monitor.getOperation().kind, "full");
    });

    it("should bind the first authoritative map without treating it as a change", async function() {
        const robot = new FakeRobot(undefined);
        const fixture = makeMonitor({robot: robot});
        await startFullAndMarkActive(fixture);

        robot.emitMap(undefined);
        robot.emitMap(64);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, ["read_preferences", "start"]);
        assert.equal(fixture.monitor.getOperation().mapId, 64);
    });

    it("should ignore new map epochs and poses on the same saved map", async function() {
        const fixture = makeMonitor();
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(64);
        fixture.robot.emitMap(undefined);
        fixture.robot.emitMap(64);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, ["read_preferences", "start"]);
    });

    it("should restart a full cleanup with enabled segment preferences after a saved-map change", async function() {
        const fixture = makeMonitor({preferenceEnabled: true});
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, [
            "read_preferences",
            "start",
            "stop",
            "enable_preferences",
            "read_preferences",
            "start"
        ]);
        assert.deepEqual(fixture.monitor.getOperation(), {
            kind: "full",
            phase: "awaiting_active",
            mapId: 68,
            targetMapId: undefined,
            segmentPreferencesEnabled: true,
            seenActive: false,
            mapChangeCount: 1
        });
    });

    it("should wait for the firmware to expose the restored preference source", async function() {
        const fixture = makeMonitor({
            preferenceEnabled: true,
            preferenceReadResults: [true, false, false, true]
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, [
            "read_preferences",
            "start",
            "stop",
            "enable_preferences",
            "read_preferences",
            "read_preferences",
            "read_preferences",
            "start"
        ]);
    });

    it("should restart a full cleanup with common settings after a saved-map change", async function() {
        const fixture = makeMonitor({preferenceEnabled: false});
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, [
            "read_preferences",
            "start",
            "stop",
            "disable_preferences",
            "read_preferences",
            "start"
        ]);
    });

    it("should use the latest saved map coalesced during preference restoration", async function() {
        let releasePreferenceWrite;
        const preferenceWriteBlocked = new Promise(resolve => {
            releasePreferenceWrite = resolve;
        });
        const fixture = makeMonitor({
            onEnablePreferences: async robot => {
                robot.emitMap(66);
                await preferenceWriteBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        releasePreferenceWrite();
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation().mapId, 66);
    });

    it("should coalesce a saved-map flap back to the original map", async function() {
        const fixture = makeMonitor({
            onStop: async robot => {
                robot.emitMap(64);
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation().mapId, 64);
    });

    it("should keep the detected target while transient maps arrive after STOP", async function() {
        const fixture = makeMonitor({
            onStop: async robot => {
                robot.emitMap(undefined);
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation().mapId, 68);
        assert.equal(fixture.calls.at(-1), "start");
    });

    it("should fail closed when the captured preference source cannot be reapplied", async function() {
        const fixture = makeMonitor({
            preferenceEnabled: true,
            preferenceWriteDoesNotApply: true
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls.slice(0, 5), [
            "read_preferences",
            "start",
            "stop",
            "enable_preferences",
            "read_preferences"
        ]);
        assert.ok(fixture.calls.filter(call => call === "read_preferences").length > 2);
        assert.deepEqual(fixture.calls.slice(-2), ["stop", "home"]);
        assert.equal(fixture.monitor.getOperation(), null);
        assert.equal(fixture.robot.events.length, 1);
        assert.match(fixture.robot.events[0].message, /could not restart/i);
    });

    it("should fail closed after three full-clean map changes", async function() {
        const fixture = makeMonitor({maxFullCleanupMapChanges: 3});
        await startFullAndMarkActive(fixture);

        for (const mapId of [68, 64, 68]) {
            fixture.robot.emitMap(mapId);
            await fixture.monitor.awaitPendingTransition();
            fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        }

        fixture.robot.emitMap(64);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 4);
        assert.equal(fixture.calls.at(-1), "home");
        assert.equal(fixture.monitor.getOperation(), null);
        assert.equal(
            fixture.robot.events[0].message,
            "Full cleanup was stopped after too many saved-map changes. " +
            "Previous map: Upper floor; localized map: Lower floor."
        );
    });

    for (const taskType of ["segment", "zone"]) {
        it(`should abort and dock ${taskType} cleanup after a saved-map change`, async function() {
            const fixture = makeMonitor();

            await fixture.monitor.startMapRelativeCleanup({
                taskType: taskType,
                start: async () => {
                    fixture.calls.push(`start_${taskType}`);
                }
            });
            fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
            fixture.robot.emitMap(68);
            await fixture.monitor.awaitPendingTransition();

            assert.deepEqual(fixture.calls, [`start_${taskType}`, "stop", "home"]);
            assert.equal(fixture.monitor.getOperation(), null);
            assert.equal(fixture.robot.events.length, 1);
            assert.equal(
                fixture.robot.events[0].message,
                `${taskType === "segment" ? "Segment" : "Zone"} cleanup was aborted because localization ` +
                "changed the saved map. Previous map: Lower floor; localized map: Upper floor."
            );
        });
    }

    it("should not expose map ids when saved maps have no names", async function() {
        const fixture = makeMonitor({robot: new FakeRobot(64, {64: 64, 68: " "})});

        await fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("start_segment");
            }
        });
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(
            fixture.robot.events[0].message,
            "Segment cleanup was aborted because localization changed the saved map. " +
            "Previous map name unavailable; localized map name unavailable."
        );
        assert.doesNotMatch(fixture.robot.events[0].message, /\b\d+\b/);
    });

    it("should identify named and unnamed maps without exposing an id", async function() {
        const fixture = makeMonitor({robot: new FakeRobot(64, {64: "Lower floor"})});

        await fixture.monitor.startMapRelativeCleanup({
            taskType: "zone",
            start: async () => {
                fixture.calls.push("start_zone");
            }
        });
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(
            fixture.robot.events[0].message,
            "Zone cleanup was aborted because localization changed the saved map. " +
            "Previous map: Lower floor; localized map name unavailable."
        );
        assert.doesNotMatch(fixture.robot.events[0].message, /\b\d+\b/);
    });

    it("should not expose map ids in a full-cleanup retry-limit notification", async function() {
        const fixture = makeMonitor({
            robot: new FakeRobot(64, {}),
            maxFullCleanupMapChanges: 0
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(
            fixture.robot.events[0].message,
            "Full cleanup was stopped after too many saved-map changes. " +
            "Previous map name unavailable; localized map name unavailable."
        );
        assert.doesNotMatch(fixture.robot.events[0].message, /\b\d+\b/);
    });

    it("should cancel a map-relative abort when the map flaps back before STOP", async function() {
        let releaseStart;
        const startBlocked = new Promise(resolve => {
            releaseStart = resolve;
        });
        const fixture = makeMonitor();

        const start = fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("start_segment");
                await startBlocked;
            }
        });
        await new Promise(resolve => setImmediate(resolve));
        fixture.robot.emitMap(68);
        fixture.robot.emitMap(64);
        releaseStart();
        await start;
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, ["start_segment"]);
        assert.equal(fixture.robot.events.length, 0);
        assert.equal(fixture.monitor.getOperation().mapId, 64);
    });

    it("should replay active status after a map-relative map flap", async function() {
        let releaseStart;
        const startBlocked = new Promise(resolve => {
            releaseStart = resolve;
        });
        const fixture = makeMonitor();

        const start = fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("start_segment");
                await startBlocked;
            }
        });
        await new Promise(resolve => setImmediate(resolve));
        fixture.robot.emitMap(68);
        fixture.robot.emitMap(64);
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        releaseStart();
        await start;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation().phase, "running");
    });

    it("should replay completion status after a map-relative map flap", async function() {
        const fixture = makeMonitor();

        await fixture.monitor.startMapRelativeCleanup({
            taskType: "zone",
            start: async () => {
                fixture.calls.push("start_zone");
            }
        });
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.emitMap(68);
        fixture.robot.emitMap(64);
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should start a requested full cleanup after a map-relative abort finishes", async function() {
        let releaseAbortStop;
        let markAbortStop;
        const abortStopEntered = new Promise(resolve => {
            markAbortStop = resolve;
        });
        const abortStopBlocked = new Promise(resolve => {
            releaseAbortStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                markAbortStop();
                await abortStopBlocked;
            }
        });
        await fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("start_segment");
            }
        });
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.emitMap(68);
        await abortStopEntered;

        const fullStart = fixture.monitor.startOrResumeFullCleanup();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.calls.filter(call => call === "start").length, 0);

        releaseAbortStop();
        await fullStart;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 1);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.calls.filter(call => call === "home").length, 1);
        assert.equal(fixture.monitor.getOperation().kind, "full");
    });

    it("should attempt HOME when STOP does not become non-resumable", async function() {
        const fixture = makeMonitor({stopLeavesResumable: true});

        await fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("start_segment");
            }
        });
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.deepEqual(fixture.calls, ["start_segment", "stop", "home"]);
        assert.equal(fixture.monitor.getOperation(), null);
        assert.match(fixture.robot.events[0].message, /stop.*failed/i);
    });

    it("should wait through docked and resumable after STOP", async function() {
        const fixture = makeMonitor({
            stopLeavesResumable: true,
            onStop: async robot => {
                setTimeout(() => {
                    robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.PAUSED);
                }, 5);
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.at(-1), "start");
        assert.equal(fixture.monitor.getOperation().mapId, 68);
    });

    it("should finish an in-flight recovery STOP before replacing it with a map-relative task", async function() {
        let releaseRecoveryStop;
        let markRecoveryStop;
        const recoveryStopEntered = new Promise(resolve => {
            markRecoveryStop = resolve;
        });
        const recoveryStopBlocked = new Promise(resolve => {
            releaseRecoveryStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                markRecoveryStop();
                await recoveryStopBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await recoveryStopEntered;
        const segmentStart = fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("segment_start");
            }
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fixture.calls.includes("segment_start"), false);

        releaseRecoveryStop();
        await segmentStart;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.calls.filter(call => call === "segment_start").length, 1);
        assert.equal(fixture.monitor.getOperation().kind, "map_relative");
    });

    it("should finish an in-flight recovery START before replacing it with a map-relative task", async function() {
        let releaseRecoveryStart;
        let markRecoveryStart;
        const recoveryStartEntered = new Promise(resolve => {
            markRecoveryStart = resolve;
        });
        const recoveryStartBlocked = new Promise(resolve => {
            releaseRecoveryStart = resolve;
        });
        const fixture = makeMonitor({
            onStart: async () => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    markRecoveryStart();
                    await recoveryStartBlocked;
                }
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await recoveryStartEntered;
        const segmentStart = fixture.monitor.startMapRelativeCleanup({
            taskType: "segment",
            start: async () => {
                fixture.calls.push("segment_start");
            }
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(fixture.calls.includes("segment_start"), false);

        releaseRecoveryStart();
        await segmentStart;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 2);
        assert.equal(fixture.calls.filter(call => call === "segment_start").length, 1);
        assert.equal(fixture.monitor.getOperation().kind, "map_relative");
    });

    it("should recover again when the saved map changes during a recovery START", async function() {
        const fixture = makeMonitor({
            onStart: async robot => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    robot.emitMap(66);
                }
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 3);
        assert.equal(fixture.calls.filter(call => call === "stop").length, 2);
        assert.equal(fixture.monitor.getOperation().mapId, 66);
        assert.equal(fixture.monitor.getOperation().mapChangeCount, 2);
    });

    it("should replay active status received during a recovery START", async function() {
        let releaseRecoveryStart;
        let markRecoveryStart;
        const recoveryStartEntered = new Promise(resolve => {
            markRecoveryStart = resolve;
        });
        const recoveryStartBlocked = new Promise(resolve => {
            releaseRecoveryStart = resolve;
        });
        const fixture = makeMonitor({
            onStart: async robot => {
                if (fixture.calls.filter(call => call === "start").length === 2) {
                    robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
                    markRecoveryStart();
                    await recoveryStartBlocked;
                }
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await recoveryStartEntered;
        releaseRecoveryStart();
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.monitor.getOperation().phase, "running");
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);
        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should ignore repeated START while a map change is being handled", async function() {
        let releaseStop;
        const stopBlocked = new Promise(resolve => {
            releaseStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                await stopBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        await new Promise(resolve => setImmediate(resolve));
        await fixture.monitor.startOrResumeFullCleanup();
        releaseStop();
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 2);
        assert.equal(fixture.calls.includes("home"), false);
    });

    it("should coalesce duplicate map updates into one recovery", async function() {
        let releaseStop;
        const stopBlocked = new Promise(resolve => {
            releaseStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                await stopBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        fixture.robot.emitMap(68);
        fixture.robot.emitMap(68);
        releaseStop();
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "stop").length, 1);
        assert.equal(fixture.calls.filter(call => call === "start").length, 2);
    });

    it("should wait for an in-flight START before sending an external STOP", async function() {
        let releaseStart;
        const startBlocked = new Promise(resolve => {
            releaseStart = resolve;
        });
        const fixture = makeMonitor({
            onStart: async () => {
                await startBlocked;
            }
        });

        const start = fixture.monitor.startOrResumeFullCleanup();
        await new Promise(resolve => setImmediate(resolve));
        const stop = fixture.monitor.stop();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(fixture.calls, ["read_preferences", "start"]);

        releaseStart();
        await start;
        await stop;

        assert.deepEqual(fixture.calls, ["read_preferences", "start", "stop"]);
        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should not restart after an external STOP cancels in-flight recovery", async function() {
        let releaseStop;
        const stopBlocked = new Promise(resolve => {
            releaseStop = resolve;
        });
        const fixture = makeMonitor({
            onStop: async () => {
                await stopBlocked;
            }
        });
        await startFullAndMarkActive(fixture);

        fixture.robot.emitMap(68);
        const externalStop = fixture.monitor.stop();
        releaseStop();
        await externalStop;
        await fixture.monitor.awaitPendingTransition();

        assert.equal(fixture.calls.filter(call => call === "start").length, 1);
        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should not clear an operation from the stale docked state immediately after START", async function() {
        const fixture = makeMonitor();

        await fixture.monitor.startOrResumeFullCleanup();
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);

        assert.notEqual(fixture.monitor.getOperation(), null);

        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
        fixture.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.DOCKED);

        assert.equal(fixture.monitor.getOperation(), null);
    });

    it("should not treat docked and resumable as completion", async function() {
        const fixture = makeMonitor();
        await startFullAndMarkActive(fixture);

        fixture.robot.setStatus(
            stateAttrs.StatusStateAttribute.VALUE.DOCKED,
            stateAttrs.StatusStateAttribute.FLAG.RESUMABLE
        );

        assert.notEqual(fixture.monitor.getOperation(), null);
    });
});
