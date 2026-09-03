const MapLayer = require("../../../entities/map/MapLayer");
const MapSegmentMaterialControlCapability = require("../../../core/capabilities/MapSegmentMaterialControlCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MapSegmentMaterialControlCapability<import("../DreameValetudoRobot")>
 */
class DreameMapSegmentMaterialControlCapability extends MapSegmentMaterialControlCapability {
    /**
     *
     * @param {object} options
     * @param {import("../DreameValetudoRobot")} options.robot
     * 
     * @param {Array<import("../../../core/capabilities/MapSegmentMaterialControlCapability").MapLayerMaterial>} options.supportedMaterials
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

        this.supportedMaterials = options.supportedMaterials;

        this.miot_actions = options.miot_actions;
        this.miot_properties = options.miot_properties;
    }

    /**
     * @param {import("../../../entities/core/ValetudoMapSegment")} segment
     * @param {import("../../../core/capabilities/MapSegmentMaterialControlCapability").MapLayerMaterial} material
     * @param {string} [mapId]
     * @returns {Promise<void>}
     */
    async setMaterial(segment, material, mapId) {
        if (!this.supportedMaterials.includes(material)) {
            throw new Error(`Unsupported material '${material}'.`);
        }

        const edit = await this.robot.prepareDreameMapEdit({}, mapId);
        const materialPayload = this.buildMaterialPayloadForMap(segment.id, material, edit.map);

        edit.payload.nsm = materialPayload;

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
                throw new RobotFirmwareError("Got error " + resultCode + " while setting segment material.");
        }
    }

    /**
     * @private
     * @param {string} targetSegmentId
     * @param {import("../../../core/capabilities/MapSegmentMaterialControlCapability").MapLayerMaterial} targetMaterial
     * @param {import("../../../entities/map/ValetudoMap")} targetMap
     * @returns {object}
     */
    buildMaterialPayloadForMap(targetSegmentId, targetMaterial, targetMap) {
        const segmentLayers = targetMap.layers.filter(layer => {
            return layer.type === MapLayer.TYPE.SEGMENT;
        });
        const payload = {};

        segmentLayers.forEach(layer => {
            const segmentId = layer.metaData.segmentId.toString();
            const material = segmentId === targetSegmentId.toString() ?
                this.mapValetudoMaterialToDreame(targetMaterial, layer.metaData) :
                this.mapCurrentSegmentMaterialToDreame(layer.metaData);

            payload[segmentId] = material;
        });

        if (payload[targetSegmentId.toString()] === undefined) {
            throw new Error(`Unknown segment '${targetSegmentId}'.`);
        }

        return payload;
    }

    /**
     * @private
     * @param {object} segmentMetaData
     * @returns {{material: number, direction?: number}}
     */
    mapCurrentSegmentMaterialToDreame(segmentMetaData) {
        if (segmentMetaData.dreameMaterial !== undefined) {
            const material = {
                material: segmentMetaData.dreameMaterial
            };

            if (segmentMetaData.dreameMaterialDirection !== undefined) {
                material.direction = segmentMetaData.dreameMaterialDirection;
            }

            return material;
        }

        return this.mapValetudoMaterialToDreame(segmentMetaData.material, segmentMetaData);
    }

    /**
     * @private
     * @param {import("../../../core/capabilities/MapSegmentMaterialControlCapability").MapLayerMaterial} material
     * @param {object} [segmentMetaData]
     * @returns {{material: number, direction?: number}}
     */
    mapValetudoMaterialToDreame(material, segmentMetaData) {
        switch (material) {
            case DreameMapSegmentMaterialControlCapability.MATERIAL.GENERIC:
                return {material: 0};
            case DreameMapSegmentMaterialControlCapability.MATERIAL.WOOD:
                if (segmentMetaData?.dreameMaterialDirection !== undefined) {
                    return {
                        material: 1,
                        direction: segmentMetaData.dreameMaterialDirection
                    };
                }

                return {material: 1};
            case DreameMapSegmentMaterialControlCapability.MATERIAL.WOOD_HORIZONTAL:
                return {
                    material: 1,
                    direction: 0
                };
            case DreameMapSegmentMaterialControlCapability.MATERIAL.WOOD_VERTICAL:
                return {
                    material: 1,
                    direction: 90
                };
            case DreameMapSegmentMaterialControlCapability.MATERIAL.TILE:
                return {material: 2};
            case DreameMapSegmentMaterialControlCapability.MATERIAL.CARPET:
                return {material: 7};
            case DreameMapSegmentMaterialControlCapability.MATERIAL.CARPET_LOW:
                return {material: 6};
            case DreameMapSegmentMaterialControlCapability.MATERIAL.CARPET_HIGH:
                return {material: 5};
            default:
                return {material: 0};
        }
    }

    getProperties() {
        return {
            supportedMaterials: this.supportedMaterials
        };
    }
}

module.exports = DreameMapSegmentMaterialControlCapability;
