const capabilities = require("../../../core/capabilities");

class MockMultiMapControlCapability extends capabilities.MultiMapControlCapability {
    /**
     * @param {object} options
     * @param {import("../MockValetudoRobot")} options.robot
     */
    constructor(options) {
        super(options);

        this.maps = [
            {id: "mock-lower", name: "Mock Lower Floor", selected: true, current: true, rotation: 0},
            {id: "mock-entry", name: "Mock Entry Floor", selected: false, current: false, rotation: 90},
            {id: "mock-upper", name: "Mock Upper Floor", selected: false, current: false, rotation: 0}
        ];
    }

    async getState() {
        return {
            maps: this.maps.map(map => ({...map})),
            selectedMapId: this.maps.find(map => map.selected)?.id
        };
    }

    async getMapPreview(mapId) {
        this.getMap(mapId);

        return this.robot.state.map;
    }

    async selectMap(mapId) {
        this.getMap(mapId);
        this.maps = this.maps.map(map => ({
            ...map,
            selected: map.id === mapId,
            current: map.id === mapId
        }));
    }

    async renameMap(mapId, name) {
        const map = this.getMap(mapId);
        map.name = name.trim() || undefined;
    }

    async deleteMap(mapId) {
        const map = this.getMap(mapId);

        if (map.selected || map.current) {
            throw new Error("Cannot delete the selected or currently loaded map.");
        }

        this.maps = this.maps.filter(candidate => candidate.id !== mapId);
    }

    async rotateMap(mapId, rotation) {
        const map = this.getMap(mapId);
        map.rotation = rotation;
    }

    getMap(mapId) {
        const map = this.maps.find(map => map.id === mapId);

        if (!map) {
            throw new Error(`Unknown map '${mapId}'.`);
        }

        return map;
    }
}

module.exports = MockMultiMapControlCapability;
