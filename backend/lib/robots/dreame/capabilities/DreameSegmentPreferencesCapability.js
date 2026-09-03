const entities = require("../../../entities");
const mapEntities = require("../../../entities/map");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");
const SegmentPreferencesCapability = require("../../../core/capabilities/SegmentPreferencesCapability");

/**
 * @extends SegmentPreferencesCapability<import("../DreameValetudoRobot")>
 */
class DreameSegmentPreferencesCapability extends SegmentPreferencesCapability {
    /**
     * @param {object} options
     * @param {import("../DreameValetudoRobot")} options.robot
     * @param {object} options.miot_actions
     * @param {object} options.miot_properties
     */
    constructor(options) {
        super(options);

        this.miot_actions = options.miot_actions;
        this.miot_properties = options.miot_properties;
    }

    /**
     * @param {string} [mapId]
     * @returns {Promise<import("../../../core/capabilities/SegmentPreferencesCapability").SegmentPreferencesState>}
     */
    async getState(mapId) {
        const edit = await this.robot.prepareDreameMapEdit({}, mapId);

        return {
            segments: this.getPreferenceLayers(edit.map)
                .map(layer => {
                    const entry = {
                        id: layer.metaData.segmentId,
                        name: layer.metaData.name,
                        cleanOrder: layer.metaData.cleanOrder
                    };

                    if (layer.metaData.dreameVisibility !== undefined) {
                        entry.visibility = layer.metaData.dreameVisibility === false ? "hidden" : "visible";
                    }

                    if (layer.metaData.dreameCleanSet !== undefined) {
                        entry.preferences = {};
                        [
                            ["suctionLevel", layer.metaData.dreameSuctionLevel],
                            ["waterVolume", layer.metaData.dreameWaterVolume],
                            ["cleaningTimes", layer.metaData.dreameCleaningTimes],
                            ["cleaningMode", layer.metaData.dreameCleaningMode],
                            ["moppingSettings", layer.metaData.dreameMoppingSettings]
                        ].forEach(([key, value]) => {
                            if (value !== undefined) {
                                entry.preferences[key] = value;
                            }
                        });
                    }

                    return entry;
                })
                .sort((a, b) => {
                    return (a.cleanOrder ?? Number.MAX_SAFE_INTEGER) - (b.cleanOrder ?? Number.MAX_SAFE_INTEGER);
                })
        };
    }

    /**
     * @param {Array<string>} segmentIds
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentOrder(segmentIds, mapId) {
        this.assertSegmentPreferencesAllowed();
        const edit = await this.robot.prepareDreameMapEdit({}, mapId);

        const knownSegmentIds = this.getSegmentLayers(edit.map).map(layer => layer.metaData.segmentId);
        const orderableSegmentIds = this.getOrderableSegmentLayers(edit.map).map(layer => layer.metaData.segmentId);
        const seenSegmentIds = new Set();
        const parsedSegmentIds = segmentIds.map(segmentId => {
            if (seenSegmentIds.has(segmentId)) {
                throw new Error(`Duplicate segment '${segmentId}'.`);
            }
            seenSegmentIds.add(segmentId);

            if (!knownSegmentIds.includes(segmentId)) {
                throw new Error(`Unknown segment '${segmentId}'.`);
            }

            if (!orderableSegmentIds.includes(segmentId)) {
                throw new Error(`Segment '${segmentId}' does not have persistent clean order metadata.`);
            }

            const parsedSegmentId = parseInt(segmentId, 10);

            if (!Number.isSafeInteger(parsedSegmentId)) {
                throw new Error(`Invalid segment '${segmentId}'.`);
            }

            return parsedSegmentId;
        });

        if (parsedSegmentIds.length !== orderableSegmentIds.length) {
            throw new Error("Clean order must include every ordered segment exactly once.");
        }

        await this.sendSegmentPreferencesPayload(
            {cleanOrder: parsedSegmentIds},
            "setting segment clean order",
            edit
        );
    }

    /**
     * @param {string} segmentId
     * @param {string} key
     * @param {number} value
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentPreference(segmentId, key, value, mapId) {
        this.assertSegmentPreferencesAllowed();
        const edit = await this.robot.prepareDreameMapEdit({}, mapId);

        const cleanSetIndex = DreameSegmentPreferencesCapability.CLEAN_SET_KEY_TO_INDEX[key];

        if (cleanSetIndex === undefined) {
            throw new Error(`Unknown segment preference '${key}'.`);
        }

        const segmentLayer = this.getKnownSegmentLayer(segmentId, edit.map);
        const parsedValue = value;

        if (!Number.isSafeInteger(parsedValue)) {
            throw new Error(`Invalid segment preference value '${value}'.`);
        }

        const cleanSet = this.getFullCleanSet(edit.map);
        cleanSet[segmentLayer.metaData.segmentId][cleanSetIndex] = parsedValue;

        await this.sendSegmentPreferencesPayload(
            {customeClean: this.serializeFullCleanSet(cleanSet, edit.map)},
            `setting segment preference '${key}'`,
            edit
        );
    }

    /**
     * @param {string} segmentId
     * @param {"visible"|"hidden"} visibility
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setSegmentVisibility(segmentId, visibility, mapId) {
        this.assertSegmentPreferencesAllowed();
        const edit = await this.robot.prepareDreameMapEdit({}, mapId);
        this.getKnownSegmentLayer(segmentId, edit.map);

        if (!["visible", "hidden"].includes(visibility)) {
            throw new Error(`Invalid segment visibility '${visibility}'.`);
        }

        const hiddenSegmentIds = this.getSegmentLayers(edit.map)
            .filter(layer => {
                if (layer.metaData.segmentId === segmentId) {
                    return visibility === "hidden";
                }

                return layer.metaData.dreameVisibility === false;
            })
            .map(layer => parseInt(layer.metaData.segmentId, 10));

        await this.sendSegmentPreferencesPayload(
            {delsr: hiddenSegmentIds},
            "setting segment visibility",
            edit
        );
    }

    /**
     * @private
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Object<string, Array<number>>}
     */
    getFullCleanSet(targetMap) {
        /** @type {Object<string, Array<number>>} */
        const cleanSet = {};

        this.getCleanSetSegmentLayers(targetMap).forEach(layer => {
            cleanSet[layer.metaData.segmentId] = layer.metaData.dreameCleanSet.slice();
        });

        return cleanSet;
    }

    /**
     * @private
     * @param {Object<string, Array<number>>} cleanSet
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Array<Array<number>>}
     */
    serializeFullCleanSet(cleanSet, targetMap) {
        return this.getCleanSetSegmentLayers(targetMap).map(layer => {
            const segmentCleanSet = cleanSet[layer.metaData.segmentId];
            const serializedCleanSet = [
                parseInt(layer.metaData.segmentId, 10),
                segmentCleanSet[0],
                segmentCleanSet[1],
                segmentCleanSet[2]
            ];

            if (segmentCleanSet.length > 4) {
                serializedCleanSet.push(...segmentCleanSet.slice(4));
            }

            return serializedCleanSet;
        });
    }

    /**
     * @private
     * @param {object} payload
     * @param {string} description
     * @param {{map: import("../../../entities/map/ValetudoMap"), payload: object}} edit
     * @returns {Promise<void>}
     */
    async sendSegmentPreferencesPayload(payload, description, edit) {
        const resultCode = await this.robot.sendDreameMapEditAction(
            {...edit.payload, ...payload},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.pollMap();
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while " + description + ".");
        }
    }

    /**
     * @private
     * @param {string} segmentId
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {import("../../../entities/map/MapLayer")}
     */
    getKnownSegmentLayer(segmentId, targetMap) {
        const segmentLayer = this.getSegmentLayers(targetMap).find(layer => layer.metaData.segmentId === segmentId);

        if (segmentLayer === undefined) {
            throw new Error(`Unknown segment '${segmentId}'.`);
        }

        return segmentLayer;
    }

    /**
     * @private
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Array<import("../../../entities/map/MapLayer")>}
     */
    getPreferenceLayers(targetMap) {
        return this.getSegmentLayers(targetMap).filter(layer => {
            return layer.metaData.cleanOrder !== undefined || layer.metaData.dreameCleanSet !== undefined || layer.metaData.dreameVisibility !== undefined;
        });
    }

    /**
     * @private
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Array<import("../../../entities/map/MapLayer")>}
     */
    getOrderableSegmentLayers(targetMap) {
        return this.getSegmentLayers(targetMap).filter(layer => layer.metaData.cleanOrder !== undefined);
    }

    /**
     * @private
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Array<import("../../../entities/map/MapLayer")>}
     */
    getCleanSetSegmentLayers(targetMap) {
        return this.getSegmentLayers(targetMap).filter(layer => layer.metaData.dreameCleanSet !== undefined);
    }

    /**
     * @private
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {Array<import("../../../entities/map/MapLayer")>}
     */
    getSegmentLayers(targetMap) {
        return (targetMap?.layers ?? []).filter(layer => {
            return layer.type === mapEntities.MapLayer.TYPE.SEGMENT && layer.metaData.segmentId !== undefined;
        });
    }

    /**
     * @private
     */
    assertSegmentPreferencesAllowed() {
        const status = this.robot.state.getFirstMatchingAttribute({
            attributeClass: entities.state.attributes.StatusStateAttribute.name
        });

        if (![
            entities.state.attributes.StatusStateAttribute.VALUE.DOCKED,
            entities.state.attributes.StatusStateAttribute.VALUE.IDLE
        ].includes(status?.value)) {
            throw new Error("Cannot edit segment preferences while the robot is active.");
        }
    }
}

DreameSegmentPreferencesCapability.CLEAN_SET_KEY_TO_INDEX = Object.freeze({
    suctionLevel: 0,
    waterVolume: 1,
    cleaningTimes: 2,
    cleaningMode: 4,
    moppingSettings: 5
});

module.exports = DreameSegmentPreferencesCapability;
