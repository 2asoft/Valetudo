const MapSegmentRenameCapability = require("../../../core/capabilities/MapSegmentRenameCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MapSegmentRenameCapability<import("../DreameValetudoRobot")>
 */
class DreameMapSegmentRenameCapability extends MapSegmentRenameCapability {
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
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {string} name
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async renameSegment(segment, name, mapId) {
        const edit = await this.robot.prepareDreameMapEdit({
            nsr: {
                [segment.id]: {
                    type: 0, //custom name?
                    name: Buffer.from(name).toString("base64")
                }
            }
        }, mapId);
        const resultCode = await this.robot.sendDreameMapEditAction(
            edit.payload,
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.pollMap();
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while naming segment.");
        }
    }
}

module.exports = DreameMapSegmentRenameCapability;
