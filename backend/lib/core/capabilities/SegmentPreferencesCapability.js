const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class SegmentPreferencesCapability extends Capability {
    /**
     * @param {string} [mapId]
     * @returns {Promise<SegmentPreferencesState>}
     */
    async getState(mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {Array<string>} segmentIds
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentOrder(segmentIds, mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} segmentId
     * @param {string} key
     * @param {number} value
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentPreference(segmentId, key, value, mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} segmentId
     * @param {"visible"|"hidden"} visibility
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentVisibility(segmentId, visibility, mapId) {
        throw new NotImplementedError();
    }

    getType() {
        return SegmentPreferencesCapability.TYPE;
    }
}

/**
 * @typedef {object} SegmentPreferencesState
 * @property {Array<SegmentPreferenceEntry>} segments
 */

/**
 * @typedef {object} SegmentPreferenceEntry
 * @property {string} id
 * @property {string|undefined} [name]
 * @property {number|undefined} [cleanOrder]
 * @property {"visible"|"hidden"|undefined} [visibility]
 * @property {object|undefined} [preferences]
 * @property {number|undefined} [preferences.suctionLevel]
 * @property {number|undefined} [preferences.waterVolume]
 * @property {number|undefined} [preferences.cleaningTimes]
 * @property {number|undefined} [preferences.cleaningMode]
 * @property {number|undefined} [preferences.moppingSettings]
 */

SegmentPreferencesCapability.TYPE = "SegmentPreferencesCapability";

module.exports = SegmentPreferencesCapability;
