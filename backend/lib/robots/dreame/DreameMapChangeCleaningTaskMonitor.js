const CallbackAttributeSubscriber = require("../../entities/CallbackAttributeSubscriber");
const ErrorStateValetudoEvent = require("../../valetudo_events/events/ErrorStateValetudoEvent");
const Logger = require("../../Logger");
const {sleep} = require("../../utils/misc");
const {StatusStateAttribute} = require("../../entities/state/attributes");

class DreameMapChangeCleaningTaskMonitor {
    /**
     * @param {object} options
     * @param {import("./DreameValetudoRobot")} options.robot
     * @param {object} options.actions
     * @param {() => Promise<void>} options.actions.start
     * @param {() => Promise<void>} options.actions.stop
     * @param {() => Promise<void>} options.actions.home
     * @param {import("./capabilities/DreameSegmentPreferencesApplyControlCapability")} options.segmentPreferencesApplyControl
     * @param {number} [options.pollIntervalMs]
     * @param {number} [options.stopTimeoutMs]
     * @param {number} [options.returnToDockTimeoutMs]
     * @param {number} [options.preferenceTimeoutMs]
     * @param {number} [options.maxFullCleanupMapChanges]
     */
    constructor(options) {
        this.robot = options.robot;
        this.actions = options.actions;
        this.segmentPreferencesApplyControl = options.segmentPreferencesApplyControl;
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
        this.stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
        this.returnToDockTimeoutMs = options.returnToDockTimeoutMs ?? 900_000;
        this.preferenceTimeoutMs = options.preferenceTimeoutMs ?? 30_000;
        this.maxFullCleanupMapChanges = options.maxFullCleanupMapChanges ?? 3;

        this.operation = null;
        this.generation = 0;
        this.commandGeneration = 0;
        this.startQueue = Promise.resolve();
        this.inFlightStartPromise = undefined;
        this.pendingTransition = Promise.resolve();
        this.pendingControlCommand = Promise.resolve();

        this.statusSubscriber = new CallbackAttributeSubscriber((eventType, status) => {
            if (status instanceof StatusStateAttribute) {
                this.handleStatusUpdate(status);
            }
        });
        this.robot.state.subscribe(this.statusSubscriber, {
            attributeClass: StatusStateAttribute.name
        });
        this.robot.onMapUpdated(() => {
            this.handleMapUpdate();
        });
    }

    /**
     * @returns {Promise<void>}
     */
    startOrResumeFullCleanup() {
        const commandGeneration = this.commandGeneration;
        const pendingControlCommand = this.pendingControlCommand;

        return this.enqueueStart(async () => {
            await pendingControlCommand;

            if (commandGeneration !== this.commandGeneration) {
                return;
            }

            if (this.operation?.phase === DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE) {
                if (this.operation.kind === DreameMapChangeCleaningTaskMonitor.OPERATION_KIND.FULL) {
                    return;
                }

                await this.pendingTransition;

                if (
                    commandGeneration !== this.commandGeneration ||
                    this.operation?.phase === DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE
                ) {
                    return;
                }
            }

            try {
                await this.robot.pollState();
            } catch (e) {
                Logger.debug("Unable to poll Dreame state before START", e);
            }

            if (commandGeneration !== this.commandGeneration) {
                return;
            }

            const status = this.getStatus();

            if (this.operation?.phase === DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE) {
                return;
            }

            if (status?.flag === StatusStateAttribute.FLAG.RESUMABLE || this.operation !== null) {
                await this.runStart(this.operation, this.actions.start);
                return;
            }

            const segmentPreferencesEnabled = await this.segmentPreferencesApplyControl.isEnabled();

            if (commandGeneration !== this.commandGeneration) {
                return;
            }

            const operation = this.replaceOperation({
                kind: DreameMapChangeCleaningTaskMonitor.OPERATION_KIND.FULL,
                phase: DreameMapChangeCleaningTaskMonitor.PHASE.AWAITING_ACTIVE,
                mapId: this.robot.getCurrentDreameSavedMapId(),
                targetMapId: undefined,
                segmentPreferencesEnabled: segmentPreferencesEnabled,
                seenActive: false,
                mapChangeCount: 0
            });

            try {
                await this.runStart(operation, this.actions.start);
            } catch (e) {
                this.clearOperation(operation);
                throw e;
            }
        });
    }

    /**
     * @param {object} options
     * @param {"segment"|"zone"} options.taskType
     * @param {() => Promise<void>} options.start
     * @returns {Promise<void>}
     */
    startMapRelativeCleanup(options) {
        const previousStartPromise = this.inFlightStartPromise;
        const previousTransition = this.pendingTransition;
        const previousControlCommand = this.pendingControlCommand;

        this.cancelOperation();
        const commandGeneration = this.commandGeneration;

        return this.enqueueStart(async () => {
            await Promise.all([
                previousStartPromise?.catch(() => undefined),
                previousTransition,
                previousControlCommand
            ]);

            if (commandGeneration !== this.commandGeneration) {
                return;
            }

            const operation = this.replaceOperation({
                kind: DreameMapChangeCleaningTaskMonitor.OPERATION_KIND.MAP_RELATIVE,
                taskType: options.taskType,
                phase: DreameMapChangeCleaningTaskMonitor.PHASE.AWAITING_ACTIVE,
                mapId: this.robot.getCurrentDreameSavedMapId(),
                targetMapId: undefined,
                seenActive: false
            });

            try {
                await this.runStart(operation, options.start);
            } catch (e) {
                this.clearOperation(operation);
                throw e;
            }
        });
    }

    /**
     * @returns {Promise<void>}
     */
    stop() {
        const startPromise = this.inFlightStartPromise;
        const pendingTransition = this.pendingTransition;
        const previousControlCommand = this.pendingControlCommand;

        this.cancelOperation();

        const command = Promise.all([
            startPromise?.catch(() => undefined),
            pendingTransition,
            previousControlCommand
        ]).then(() => this.actions.stop());

        this.pendingControlCommand = command.catch(() => undefined);

        return command;
    }

    /**
     * @returns {Promise<void>}
     */
    home() {
        const startPromise = this.inFlightStartPromise;
        const pendingTransition = this.pendingTransition;
        const previousControlCommand = this.pendingControlCommand;

        this.cancelOperation();

        const command = Promise.all([
            startPromise?.catch(() => undefined),
            pendingTransition,
            previousControlCommand
        ]).then(() => this.actions.home());

        this.pendingControlCommand = command.catch(() => undefined);

        return command;
    }

    /**
     * @returns {object|null}
     */
    getOperation() {
        if (this.operation === null) {
            return null;
        }

        const operation = {...this.operation};
        delete operation.generation;
        delete operation.startPromise;

        return operation;
    }

    /**
     * @returns {Promise<void>}
     */
    async awaitPendingTransition() {
        await this.pendingTransition;
    }

    /**
     * @private
     * @param {() => Promise<void>} fn
     * @returns {Promise<void>}
     */
    enqueueStart(fn) {
        const result = this.startQueue.then(fn, fn);

        this.startQueue = result.catch(() => undefined);

        return result;
    }

    /**
     * @private
     * @param {object|null} operation
     * @param {() => Promise<void>} start
     * @returns {Promise<void>}
     */
    async runStart(operation, start) {
        const startPromise = start();

        this.inFlightStartPromise = startPromise;

        if (operation) {
            operation.startPromise = startPromise;
        }

        try {
            await startPromise;
        } finally {
            if (this.inFlightStartPromise === startPromise) {
                this.inFlightStartPromise = undefined;
            }

            if (operation?.startPromise === startPromise) {
                operation.startPromise = undefined;
            }
        }
    }

    /**
     * @private
     * @param {object} operation
     * @returns {object}
     */
    replaceOperation(operation) {
        this.generation++;
        this.operation = {
            ...operation,
            generation: this.generation
        };

        return this.operation;
    }

    /**
     * @private
     */
    cancelOperation() {
        this.commandGeneration++;
        this.generation++;
        this.operation = null;
    }

    /**
     * @private
     * @param {object} operation
     */
    clearOperation(operation) {
        if (this.isCurrentOperation(operation)) {
            this.generation++;
            this.operation = null;
        }
    }

    /**
     * @private
     * @param {object} operation
     * @returns {boolean}
     */
    isCurrentOperation(operation) {
        return this.operation === operation && operation.generation === this.generation;
    }

    /**
     * @private
     * @returns {import("../../entities/state/attributes/StatusStateAttribute")|null}
     */
    getStatus() {
        return this.robot.state.getFirstMatchingAttributeByConstructor(StatusStateAttribute);
    }

    /**
     * @private
     * @param {import("../../entities/state/attributes/StatusStateAttribute")} status
     */
    handleStatusUpdate(status) {
        const operation = this.operation;

        if (operation === null || operation.phase === DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE) {
            return;
        }

        if (status.isActiveState) {
            operation.seenActive = true;
            operation.phase = DreameMapChangeCleaningTaskMonitor.PHASE.RUNNING;
            return;
        }

        if (status.value === StatusStateAttribute.VALUE.ERROR) {
            this.clearOperation(operation);
            return;
        }

        if (
            operation.phase === DreameMapChangeCleaningTaskMonitor.PHASE.RUNNING &&
            DreameMapChangeCleaningTaskMonitor.IS_NORMAL_COMPLETION_STATUS(status)
        ) {
            this.clearOperation(operation);
        }
    }

    /**
     * @private
     */
    handleMapUpdate() {
        const operation = this.operation;
        const mapId = this.robot.getCurrentDreameSavedMapId();

        if (operation === null || !Number.isSafeInteger(mapId)) {
            return;
        }

        if (!Number.isSafeInteger(operation.mapId)) {
            operation.mapId = mapId;
            return;
        }

        if (operation.phase === DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE) {
            operation.targetMapId = mapId;
            return;
        }

        if (operation.mapId === mapId) {
            return;
        }

        operation.targetMapId = mapId;

        operation.phase = DreameMapChangeCleaningTaskMonitor.PHASE.HANDLING_MAP_CHANGE;

        Logger.info("Handling saved-map change during Dreame cleanup", {
            taskKind: operation.kind === DreameMapChangeCleaningTaskMonitor.OPERATION_KIND.FULL ?
                operation.kind : operation.taskType,
            fromMapId: operation.mapId,
            toMapId: mapId
        });

        if (operation.kind === DreameMapChangeCleaningTaskMonitor.OPERATION_KIND.FULL) {
            operation.mapChangeCount++;
            this.setPendingTransition(() => {
                return this.handleFullCleanupMapChange(operation);
            });
        } else {
            this.setPendingTransition(() => {
                return this.handleMapRelativeCleanupMapChange(operation);
            });
        }
    }

    /**
     * @private
     * @param {() => Promise<void>} transition
     */
    setPendingTransition(transition) {
        const pendingTransition = Promise.resolve().then(transition).catch(e => {
            Logger.error("Unhandled Dreame cleanup map-change transition error", e);
        });

        this.pendingTransition = pendingTransition;
    }

    /**
     * @private
     * @param {number|undefined} previousMapId
     * @param {number|undefined} localizedMapId
     * @returns {string}
     */
    describeMapChange(previousMapId, localizedMapId) {
        const previousMapName = this.robot.getDreameSavedMapName(previousMapId);
        const localizedMapName = this.robot.getDreameSavedMapName(localizedMapId);
        const previousMapDescription = typeof previousMapName === "string" && previousMapName.trim().length > 0 ?
            `Previous map: ${previousMapName.trim()}` : "Previous map name unavailable";
        const localizedMapDescription = typeof localizedMapName === "string" && localizedMapName.trim().length > 0 ?
            `localized map: ${localizedMapName.trim()}` : "localized map name unavailable";

        return `${previousMapDescription}; ${localizedMapDescription}`;
    }

    /**
     * @private
     * @param {object} operation
     * @returns {Promise<void>}
     */
    async handleFullCleanupMapChange(operation) {
        if (operation.startPromise) {
            try {
                await operation.startPromise;
            } catch (e) {
                if (!this.isCurrentOperation(operation)) {
                    return;
                }
            }
        }

        if (!this.isCurrentOperation(operation)) {
            return;
        }

        if (operation.mapChangeCount > this.maxFullCleanupMapChanges) {
            await this.failClosed(
                operation,
                "Full cleanup was stopped after too many saved-map changes. " +
                `${this.describeMapChange(operation.mapId, operation.targetMapId)}.`
            );
            return;
        }

        try {
            await this.actions.stop();

            if (!this.isCurrentOperation(operation)) {
                return;
            }

            const stopped = await this.waitForStatus(
                operation,
                DreameMapChangeCleaningTaskMonitor.IS_STOPPED_STATUS,
                this.stopTimeoutMs
            );

            if (!stopped || !this.isCurrentOperation(operation)) {
                return;
            }

            if (operation.segmentPreferencesEnabled) {
                await this.segmentPreferencesApplyControl.enable();
            } else {
                await this.segmentPreferencesApplyControl.disable();
            }

            if (!this.isCurrentOperation(operation)) {
                return;
            }

            const preferenceApplied = await this.waitForPreferenceSource(
                operation,
                operation.segmentPreferencesEnabled
            );

            if (!preferenceApplied || !this.isCurrentOperation(operation)) {
                return;
            }

            const targetMapId = operation.targetMapId;

            if (!Number.isSafeInteger(targetMapId)) {
                throw new Error("The localized saved map is unavailable");
            }

            operation.mapId = targetMapId;
            operation.targetMapId = undefined;
            operation.seenActive = false;

            if (!this.isCurrentOperation(operation)) {
                return;
            }

            await this.runStart(operation, this.actions.start);

            if (!this.isCurrentOperation(operation)) {
                return;
            }

            const latestMapId = operation.targetMapId;

            if (Number.isSafeInteger(latestMapId) && latestMapId !== operation.mapId) {
                operation.mapChangeCount++;

                Logger.info("Handling saved-map change during Dreame cleanup", {
                    taskKind: operation.kind,
                    fromMapId: operation.mapId,
                    toMapId: latestMapId
                });

                await this.handleFullCleanupMapChange(operation);
                return;
            }

            operation.targetMapId = undefined;
            operation.phase = DreameMapChangeCleaningTaskMonitor.PHASE.AWAITING_ACTIVE;

            const status = this.getStatus();

            if (status) {
                this.handleStatusUpdate(status);
            }

            Logger.info("Restarted Dreame full cleanup after saved-map change", {
                mapId: targetMapId,
                segmentPreferencesEnabled: operation.segmentPreferencesEnabled,
                mapChangeCount: operation.mapChangeCount
            });
        } catch (e) {
            operation.startPromise = undefined;

            if (this.isCurrentOperation(operation)) {
                await this.failClosed(
                    operation,
                    `Full cleanup could not restart after localization changed saved maps: ${e.message}`
                );
            }
        }
    }

    /**
     * @private
     * @param {object} operation
     * @returns {Promise<void>}
     */
    async handleMapRelativeCleanupMapChange(operation) {
        if (operation.startPromise) {
            try {
                await operation.startPromise;
            } catch (e) {
                return;
            }
        }

        if (!this.isCurrentOperation(operation)) {
            return;
        }

        if (operation.targetMapId === operation.mapId) {
            operation.targetMapId = undefined;
            operation.phase = operation.seenActive ?
                DreameMapChangeCleaningTaskMonitor.PHASE.RUNNING :
                DreameMapChangeCleaningTaskMonitor.PHASE.AWAITING_ACTIVE;

            const status = this.getStatus();

            if (status) {
                this.handleStatusUpdate(status);
            }
            return;
        }

        const taskName = DreameMapChangeCleaningTaskMonitor.MAP_RELATIVE_TASK_NAMES[operation.taskType];

        await this.failClosed(
            operation,
            `${taskName} cleanup was aborted because localization changed the saved map. ` +
            `${this.describeMapChange(operation.mapId, operation.targetMapId)}.`
        );
    }

    /**
     * @private
     * @param {object} operation
     * @param {string} message
     * @returns {Promise<void>}
     */
    async failClosed(operation, message) {
        const failures = [];

        if (!this.isCurrentOperation(operation)) {
            return;
        }

        try {
            await this.actions.stop();

            if (!this.isCurrentOperation(operation)) {
                return;
            }

            const stopped = await this.waitForStatus(
                operation,
                DreameMapChangeCleaningTaskMonitor.IS_STOPPED_STATUS,
                this.stopTimeoutMs
            );

            if (!stopped || !this.isCurrentOperation(operation)) {
                return;
            }
        } catch (e) {
            failures.push(`Stopping cleanup failed: ${e.message}`);
        }

        if (!this.isCurrentOperation(operation)) {
            return;
        }

        const status = this.getStatus();

        if (!status || !DreameMapChangeCleaningTaskMonitor.IS_DOCKED_STATUS(status)) {
            try {
                if (!this.isCurrentOperation(operation)) {
                    return;
                }

                await this.actions.home();

                if (!this.isCurrentOperation(operation)) {
                    return;
                }

                const docked = await this.waitForStatus(
                    operation,
                    DreameMapChangeCleaningTaskMonitor.IS_DOCKED_STATUS,
                    this.returnToDockTimeoutMs
                );

                if (!docked || !this.isCurrentOperation(operation)) {
                    return;
                }
            } catch (e) {
                failures.push(`Returning to the dock failed: ${e.message}`);
            }
        }

        if (!this.isCurrentOperation(operation)) {
            return;
        }

        if (failures.length > 0) {
            message += ` ${failures.join(" ")}`;
        }

        Logger.warn(message);
        this.robot.valetudoEventStore.raise(new ErrorStateValetudoEvent({
            message: message
        }));
        this.clearOperation(operation);
    }

    /**
     * @private
     * @param {object} operation
     * @param {boolean} expected
     * @returns {Promise<boolean>}
     */
    async waitForPreferenceSource(operation, expected) {
        const deadline = Date.now() + this.preferenceTimeoutMs;

        while (Date.now() <= deadline) {
            if (!this.isCurrentOperation(operation)) {
                return false;
            }

            try {
                if (await this.segmentPreferencesApplyControl.isEnabled() === expected) {
                    return true;
                }
            } catch (e) {
                Logger.debug("Unable to read the Dreame full-clean preference source after writing it", e);
            }

            await sleep(this.pollIntervalMs);
        }

        throw new Error("Timed out while waiting for the full-clean preference source");
    }

    /**
     * @private
     * @param {object} operation
     * @param {(status: import("../../entities/state/attributes/StatusStateAttribute")) => boolean} predicate
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    async waitForStatus(operation, predicate, timeoutMs) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            if (!this.isCurrentOperation(operation)) {
                return false;
            }

            const status = this.getStatus();

            if (status?.value === StatusStateAttribute.VALUE.ERROR) {
                throw new Error(status.error?.message ?? "The robot entered an error state");
            }

            if (status && predicate(status)) {
                return true;
            }

            try {
                await this.robot.pollState();
            } catch (e) {
                Logger.debug("Unable to poll Dreame state while handling a cleanup map change", e);
            }

            if (!this.isCurrentOperation(operation)) {
                return false;
            }

            const polledStatus = this.getStatus();

            if (polledStatus?.value === StatusStateAttribute.VALUE.ERROR) {
                throw new Error(polledStatus.error?.message ?? "The robot entered an error state");
            }

            if (polledStatus && predicate(polledStatus)) {
                return true;
            }

            await sleep(this.pollIntervalMs);
        }

        throw new Error("Timed out while waiting for robot state");
    }
}

DreameMapChangeCleaningTaskMonitor.OPERATION_KIND = Object.freeze({
    FULL: "full",
    MAP_RELATIVE: "map_relative"
});

DreameMapChangeCleaningTaskMonitor.MAP_RELATIVE_TASK_NAMES = Object.freeze({
    segment: "Segment",
    zone: "Zone"
});

DreameMapChangeCleaningTaskMonitor.PHASE = Object.freeze({
    AWAITING_ACTIVE: "awaiting_active",
    RUNNING: "running",
    HANDLING_MAP_CHANGE: "handling_map_change"
});

DreameMapChangeCleaningTaskMonitor.IS_STOPPED_STATUS = status => {
    return !status.isActiveState &&
        status.value !== StatusStateAttribute.VALUE.ERROR &&
        status.flag !== StatusStateAttribute.FLAG.RESUMABLE;
};

DreameMapChangeCleaningTaskMonitor.IS_DOCKED_STATUS = status => {
    return status.value === StatusStateAttribute.VALUE.DOCKED &&
        status.flag !== StatusStateAttribute.FLAG.RESUMABLE;
};

DreameMapChangeCleaningTaskMonitor.IS_NORMAL_COMPLETION_STATUS = status => {
    return [
        StatusStateAttribute.VALUE.IDLE,
        StatusStateAttribute.VALUE.DOCKED
    ].includes(status.value) && status.flag !== StatusStateAttribute.FLAG.RESUMABLE;
};

module.exports = DreameMapChangeCleaningTaskMonitor;
