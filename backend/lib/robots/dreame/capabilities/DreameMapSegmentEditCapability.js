const DreameMapParser = require("../DreameMapParser");
const MapSegmentEditCapability = require("../../../core/capabilities/MapSegmentEditCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MapSegmentEditCapability<import("../DreameValetudoRobot")>
 */
class DreameMapSegmentEditCapability extends MapSegmentEditCapability {
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
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentA
     * @param {import("../../../entities/core/ValetudoMapSegment")} segmentB
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async joinSegments(segmentA, segmentB, mapId) {
        const edit = await this.robot.prepareDreameMapEdit(
            {msr: [parseInt(segmentA.id), parseInt(segmentB.id)]},
            mapId
        );
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
            case 1:
                throw new RobotFirmwareError("Segment join failed. Can't join segments that aren't adjacent to each other.");
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while merging segments.");
        }
    }

    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {object} pA
     * @param {number} pA.x
     * @param {number} pA.y
     * @param {object} pB
     * @param {number} pB.x
     * @param {number} pB.y
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async splitSegment(segment, pA, pB, mapId) {
        pA = DreameMapParser.CONVERT_TO_DREAME_COORDINATES(pA.x, pA.y);
        pB = DreameMapParser.CONVERT_TO_DREAME_COORDINATES(pB.x, pB.y);

        const edit = await this.robot.prepareDreameMapEdit({
            dsr: [pA.x, pA.y, pB.x, pB.y],
            dsrid: [pA.x, pA.y, pB.x, pB.y, parseInt(segment.id)]
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
            case 5:
                throw new RobotFirmwareError("Failed to split segment. Both ends of the cutting line need to be connected with a wall surrounding the chosen segment.");
            case 6:
                throw new RobotFirmwareError("Failed to split segment. At least one of the resulting segments is too small.");
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while splitting segments.");
        }
    }
}

module.exports = DreameMapSegmentEditCapability;
