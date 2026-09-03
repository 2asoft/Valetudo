const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameBasicControlCapability = require("../../../../lib/robots/dreame/capabilities/DreameBasicControlCapability");
const DreameMapSegmentationCapability = require("../../../../lib/robots/dreame/capabilities/DreameMapSegmentationCapability");
const DreameValetudoRobot = require("../../../../lib/robots/dreame/DreameValetudoRobot");
const DreameZoneCleaningCapability = require("../../../../lib/robots/dreame/capabilities/DreameZoneCleaningCapability");
const ValetudoMapSegment = require("../../../../lib/entities/core/ValetudoMapSegment");
const ValetudoZone = require("../../../../lib/entities/core/ValetudoZone");

const makeRobot = () => {
    const calls = [];
    const robot = {
        state: {
            getFirstMatchingAttribute: () => null
        },
        miotHelper: {
            executeAction: async (...args) => {
                calls.push(args);
            }
        }
    };

    return {robot: robot, calls: calls};
};

const makeBasicCapability = robot => {
    return new DreameBasicControlCapability({
        robot: robot,
        miot_actions: {
            start: {siid: 2, aiid: 1},
            stop: {siid: 4, aiid: 2},
            pause: {siid: 2, aiid: 2},
            home: {siid: 3, aiid: 1}
        }
    });
};

const makeSegmentCapability = robot => {
    return new DreameMapSegmentationCapability({
        robot: robot,
        miot_actions: {
            start: {siid: 4, aiid: 1}
        },
        miot_properties: {
            mode: {piid: 1},
            additionalCleanupParameters: {piid: 10}
        },
        segmentCleaningModeId: 18,
        iterationsSupported: 4,
        customOrderSupported: true,
        newOrder: true
    });
};

const makeZoneCapability = robot => {
    return new DreameZoneCleaningCapability({
        robot: robot,
        miot_actions: {
            start: {siid: 4, aiid: 1}
        },
        miot_properties: {
            mode: {piid: 1},
            additionalCleanupParameters: {piid: 10}
        },
        zoneCleaningModeId: 19,
        maxZoneCount: 4
    });
};

describe("Dreame cleanup task monitor integration", function() {
    it("should preserve raw Basic Control MIOT actions without a monitor", async function() {
        const {robot, calls} = makeRobot();
        const capability = makeBasicCapability(robot);

        await capability.start();
        await capability.stop();
        await capability.pause();
        await capability.home();

        assert.deepEqual(calls, [
            [2, 1],
            [4, 2],
            [2, 2],
            [3, 1]
        ]);
    });

    it("should delegate START, STOP, and HOME through the injected monitor", async function() {
        const {robot, calls} = makeRobot();
        const monitorCalls = [];
        const capability = makeBasicCapability(robot);
        capability.setCleaningTaskMonitor({
            startOrResumeFullCleanup: async () => monitorCalls.push("start"),
            stop: async () => monitorCalls.push("stop"),
            home: async () => monitorCalls.push("home")
        });

        await capability.start();
        await capability.stop();
        await capability.pause();
        await capability.home();

        assert.deepEqual(monitorCalls, ["start", "stop", "home"]);
        assert.deepEqual(calls, [[2, 2]]);
    });

    it("should execute a segment action through the injected map-relative monitor", async function() {
        const {robot, calls} = makeRobot();
        const monitorCalls = [];
        const capability = makeSegmentCapability(robot);
        capability.setCleaningTaskMonitor({
            startMapRelativeCleanup: async options => {
                monitorCalls.push(options.taskType);
                await options.start();
            }
        });

        await capability.executeSegmentAction([
            new ValetudoMapSegment({id: "8"}),
            new ValetudoMapSegment({id: "4"})
        ], {iterations: 1, customOrder: true});

        assert.deepEqual(monitorCalls, ["segment"]);
        assert.deepEqual(calls, [[4, 1, [
            {piid: 1, value: 18},
            {piid: 10, value: "{\"selects\":[[8,1,1,1,1],[4,1,1,1,1]]}"}
        ]]]);
    });

    it("should execute a zone action through the injected map-relative monitor", async function() {
        const {robot, calls} = makeRobot();
        const monitorCalls = [];
        const capability = makeZoneCapability(robot);
        capability.setCleaningTaskMonitor({
            startMapRelativeCleanup: async options => {
                monitorCalls.push(options.taskType);
                await options.start();
            }
        });

        await capability.start({
            zones: [new ValetudoZone({
                points: {
                    pA: {x: 10, y: 20},
                    pB: {x: 10, y: 40},
                    pC: {x: 30, y: 40},
                    pD: {x: 30, y: 20}
                }
            })],
            iterations: 1
        });

        assert.deepEqual(monitorCalls, ["zone"]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 4);
        assert.equal(calls[0][1], 1);
        assert.equal(calls[0][2][0].value, 19);
        assert.match(calls[0][2][1].value, /^\{"areas":\[/);
    });

    it("should return names only for known saved maps with displayable names", function() {
        const robot = Object.create(DreameValetudoRobot.prototype);
        robot.dreameMapState = {
            knownMapIds: [64, 68],
            mapInfoById: {
                3: {name: "Unknown map"},
                64: {name: " Lower floor "},
                66: {name: "Stale map"},
                68: {name: 68}
            }
        };

        assert.equal(robot.getDreameSavedMapName(64), "Lower floor");
        assert.equal(robot.getDreameSavedMapName(3), undefined);
        assert.equal(robot.getDreameSavedMapName(66), undefined);
        assert.equal(robot.getDreameSavedMapName(68), undefined);
        assert.equal(robot.getDreameSavedMapName(undefined), undefined);
    });

    it("should derive current saved-map identity only from the authoritative current map", function() {
        const robot = Object.create(DreameValetudoRobot.prototype);
        robot.dreameMapState = {
            knownMapIds: [64, 68]
        };

        robot.state = {map: {metaData: {defaultMap: true}}};
        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);

        robot.state.map = {metaData: {dreameMapId: 19}};
        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);

        robot.state.map = {metaData: {dreameMapId: 4, dreameRismMapId: 68}};
        assert.equal(robot.getCurrentDreameSavedMapId(), 68);

        robot.state.map = {metaData: {dreameMapId: 64}};
        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);
    });
});
