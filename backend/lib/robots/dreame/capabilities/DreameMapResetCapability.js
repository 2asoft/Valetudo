const MapResetCapability = require("../../../core/capabilities/MapResetCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MapResetCapability<import("../DreameValetudoRobot")>
 */
class DreameMapResetCapability extends MapResetCapability {
    /**
     *
     * @param {object} options
     * @param {import("../DreameValetudoRobot")} options.robot
     *
     * @param {object} options.miot_actions
     * @param {object} options.miot_actions.map_edit
     * @param {number} options.miot_actions.map_edit.siid
     * @param {number} options.miot_actions.map_edit.aiid
     *
     * @param {object} options.miot_properties
     * @param {object} options.miot_properties.mapDetails
     * @param {number} options.miot_properties.mapDetails.piid
     * @param {object} options.miot_properties.actionResult
     * @param {number} options.miot_properties.actionResult.piid
     *
     */
    constructor(options) {
        super(options);

        this.miot_actions = options.miot_actions;
        this.miot_properties = options.miot_properties;
    }

    /**
     * @returns {Promise<void>}
     */
    async reset() {
        const resultCode = await this.robot.sendDreameMapEditAction(
            {cm: {}},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.clearValetudoMap();
                this.robot.pollMap();
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while resetting map.");
        }

    }
}

module.exports = DreameMapResetCapability;
