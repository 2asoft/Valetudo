const Capability = require("./Capability");
const NotImplementedError = require("../NotImplementedError");

/**
 * @template {import("../ValetudoRobot")} T
 * @extends Capability<T>
 */
class MultiMapControlCapability extends Capability {
    /**
     * @returns {Promise<MultiMapState>}
     */
    async getState() {
        throw new NotImplementedError();
    }

    /**
     * @param {string} mapId
     * @returns {Promise<import("../../entities/map/ValetudoMap")>}
     */
    async getMapPreview(mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} mapId
     * @returns {Promise<void>}
     */
    async selectMap(mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} mapId
     * @param {string} name
     * @returns {Promise<void>}
     */
    async renameMap(mapId, name) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} mapId
     * @returns {Promise<void>}
     */
    async deleteMap(mapId) {
        throw new NotImplementedError();
    }

    /**
     * @param {string} mapId
     * @param {number} rotation
     * @returns {Promise<void>}
     */
    async rotateMap(mapId, rotation) {
        throw new NotImplementedError();
    }

    getType() {
        return MultiMapControlCapability.TYPE;
    }
}

/**
 * @typedef {object} MultiMapState
 * @property {Array<MultiMapEntry>} maps
 * @property {string|undefined} selectedMapId
 */

/**
 * @typedef {object} MultiMapEntry
 * @property {string} id
 * @property {string|undefined} [name]
 * @property {boolean} selected
 * @property {boolean} current
 * @property {number|undefined} [rotation]
 */

MultiMapControlCapability.TYPE = "MultiMapControlCapability";

module.exports = MultiMapControlCapability;
