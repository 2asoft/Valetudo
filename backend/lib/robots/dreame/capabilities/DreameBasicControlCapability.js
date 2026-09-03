const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");

/**
 * @extends BasicControlCapability<import("../DreameValetudoRobot")>
 */
class DreameBasicControlCapability extends BasicControlCapability {
    /**
     * The most basic functionalities
     *
     * @param {object} options
     * @param {import("../DreameValetudoRobot")} options.robot
     *
     * @param {object} options.miot_actions
     * @param {object} options.miot_actions.start
     * @param {number} options.miot_actions.start.siid
     * @param {number} options.miot_actions.start.aiid
     *
     * @param {object} options.miot_actions.stop
     * @param {number} options.miot_actions.stop.siid
     * @param {number} options.miot_actions.stop.aiid
     *
     * @param {object} options.miot_actions.pause
     * @param {number} options.miot_actions.pause.siid
     * @param {number} options.miot_actions.pause.aiid
     *
     * @param {object} options.miot_actions.home
     * @param {number} options.miot_actions.home.siid
     * @param {number} options.miot_actions.home.aiid
     */
    constructor(options) {
        super(options);

        this.miot_actions = options.miot_actions;
        this.cleaningTaskMonitor = undefined;
    }

    /**
     * @param {import("../DreameMapChangeCleaningTaskMonitor")} monitor
     */
    setCleaningTaskMonitor(monitor) {
        this.cleaningTaskMonitor = monitor;
    }

    async start() {
        if (this.cleaningTaskMonitor) {
            await this.cleaningTaskMonitor.startOrResumeFullCleanup();
        } else {
            await this.executeStartAction();
        }
    }

    async stop() {
        if (this.cleaningTaskMonitor) {
            await this.cleaningTaskMonitor.stop();
        } else {
            await this.executeStopAction();
        }
    }

    async pause() {
        await this.robot.miotHelper.executeAction(this.miot_actions.pause.siid, this.miot_actions.pause.aiid);
    }

    async home() {
        if (this.cleaningTaskMonitor) {
            await this.cleaningTaskMonitor.home();
        } else {
            await this.executeHomeAction();
        }
    }

    async executeStartAction() {
        await this.robot.miotHelper.executeAction(this.miot_actions.start.siid, this.miot_actions.start.aiid);
    }

    async executeStopAction() {
        await this.robot.miotHelper.executeAction(this.miot_actions.stop.siid, this.miot_actions.stop.aiid);
    }

    async executeHomeAction() {
        await this.robot.miotHelper.executeAction(this.miot_actions.home.siid, this.miot_actions.home.aiid);
    }
}

module.exports = DreameBasicControlCapability;
