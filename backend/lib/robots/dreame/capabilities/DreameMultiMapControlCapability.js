const entities = require("../../../entities");
const MultiMapControlCapability = require("../../../core/capabilities/MultiMapControlCapability");
const RobotFirmwareError = require("../../../core/RobotFirmwareError");

/**
 * @extends MultiMapControlCapability<import("../DreameValetudoRobot")>
 */
class DreameMultiMapControlCapability extends MultiMapControlCapability {
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
     * @returns {Promise<import("../../../core/capabilities/MultiMapControlCapability").MultiMapState>}
     */
    async getState() {
        const selectedMapId = this.robot.dreameMapState.selectedMapId;
        const currentMapId = this.robot.getCurrentDreameSavedMapId();
        const mapInfoById = this.robot.dreameMapState.mapInfoById ?? {};

        return {
            selectedMapId: selectedMapId?.toString(),
            maps: this.robot.dreameMapState.knownMapIds.map(mapId => {
                return {
                    id: mapId.toString(),
                    name: mapInfoById[mapId]?.name,
                    selected: mapId === selectedMapId,
                    current: mapId === currentMapId,
                    rotation: mapInfoById[mapId]?.rotation
                };
            })
        };
    }

    /**
     * @param {string} mapId
     * @returns {Promise<import("../../../entities/map/ValetudoMap")>}
     */
    async getMapPreview(mapId) {
        const parsedMapId = this.parseKnownMapId(mapId);

        return this.robot.getDreameSavedMapPreview(parsedMapId);
    }

    /**
     * @param {string} mapId
     * @returns {Promise<void>}
     */
    async selectMap(mapId) {
        const parsedMapId = this.parseKnownMapId(mapId);
        this.assertMapManagementAllowed();

        const resultCode = await this.robot.sendDreameMapEditAction(
            {sm: {}, mapid: parsedMapId},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.dreameMapState.selectedMapId = parsedMapId;
                this.robot.pollMap();
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while selecting map.");
        }
    }

    /**
     * @param {string} mapId
     * @param {string} name
     * @returns {Promise<void>}
     */
    async renameMap(mapId, name) {
        const parsedMapId = this.parseKnownMapId(mapId);
        this.assertMapManagementAllowed();

        const resultCode = await this.robot.sendDreameMapEditAction(
            {nrism: {[parsedMapId]: {name: name.trim()}}},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.dreameMapState.mapInfoById[parsedMapId] = {
                    ...this.robot.dreameMapState.mapInfoById[parsedMapId],
                    name: name.trim()
                };
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while renaming map.");
        }
    }

    /**
     * @param {string} mapId
     * @returns {Promise<void>}
     */
    async deleteMap(mapId) {
        const parsedMapId = this.parseKnownMapId(mapId);
        this.assertMapManagementAllowed();

        if (parsedMapId === this.robot.dreameMapState.selectedMapId || parsedMapId === this.robot.getCurrentDreameSavedMapId()) {
            throw new Error("Cannot delete the selected or currently loaded map.");
        }

        const resultCode = await this.robot.sendDreameMapEditAction(
            {cm: {}, mapid: parsedMapId},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.dreameMapState.knownMapIds = this.robot.dreameMapState.knownMapIds.filter(id => id !== parsedMapId);
                delete this.robot.dreameMapState.mapInfoById[parsedMapId];
                delete this.robot.dreameMapState.mapPreviewDataById[parsedMapId];
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while deleting map.");
        }
    }

    /**
     * @param {string} mapId
     * @param {number} rotation
     * @returns {Promise<void>}
     */
    async rotateMap(mapId, rotation) {
        const parsedMapId = this.parseKnownMapId(mapId);
        this.assertMapManagementAllowed();

        if (![0, 90, 180, 270].includes(rotation)) {
            throw new Error("Invalid map rotation.");
        }

        const resultCode = await this.robot.sendDreameMapEditAction(
            {smra: {[parsedMapId]: {ra: rotation}}},
            this.miot_actions,
            this.miot_properties,
            {timeout: 5000}
        );

        switch (resultCode) {
            case 0:
                this.robot.dreameMapState.mapInfoById[parsedMapId] = {
                    ...this.robot.dreameMapState.mapInfoById[parsedMapId],
                    rotation: rotation
                };

                if (parsedMapId === this.robot.getCurrentDreameSavedMapId() && this.robot.state.map) {
                    this.robot.state.map = this.robot.applyDreameMapRotation(this.robot.state.map, rotation);
                    this.robot.emitMapUpdated();
                }
                return;
            default:
                throw new RobotFirmwareError("Got error " + resultCode + " while rotating map.");
        }
    }

    /**
     * @private
     * @param {string} mapId
     * @returns {number}
     */
    parseKnownMapId(mapId) {
        const parsedMapId = /^(0|[1-9]\d*)$/.test(mapId) ? Number(mapId) : undefined;

        if (!Number.isSafeInteger(parsedMapId) || !this.robot.dreameMapState.knownMapIds.includes(parsedMapId)) {
            throw new Error(`Unknown map '${mapId}'.`);
        }

        return parsedMapId;
    }

    /**
     * @private
     */
    assertMapManagementAllowed() {
        const status = this.robot.state.getFirstMatchingAttribute({
            attributeClass: entities.state.attributes.StatusStateAttribute.name
        });

        if (![
            entities.state.attributes.StatusStateAttribute.VALUE.DOCKED,
            entities.state.attributes.StatusStateAttribute.VALUE.IDLE
        ].includes(status?.value)) {
            throw new Error("Cannot edit saved maps while the robot is active.");
        }
    }
}

module.exports = DreameMultiMapControlCapability;
