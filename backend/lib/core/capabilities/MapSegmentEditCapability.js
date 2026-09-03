const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class MapSegmentEditCapability extends Capability {
    /**
     * @param {import("../../entities/core/ValetudoMapSegment")} segmentA
     * @param {import("../../entities/core/ValetudoMapSegment")} segmentB
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async joinSegments(segmentA, segmentB, mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {import("../../entities/core/ValetudoMapSegment")} segment
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
        throw new NotImplementedError();
    }

    getType() {
        return MapSegmentEditCapability.TYPE;
    }
}

MapSegmentEditCapability.TYPE = "MapSegmentEditCapability";

module.exports = MapSegmentEditCapability;
