const capabilities = require("../../../core/capabilities");

class MockSegmentPreferencesCapability extends capabilities.SegmentPreferencesCapability {
    /**
     * @param {object} options
     * @param {import("../MockValetudoRobot")} options.robot
     */
    constructor(options) {
        super(options);

        /**
         * @type {Array<import("../../../core/capabilities/SegmentPreferencesCapability").SegmentPreferenceEntry>}
         */
        this.segments = [
            {id: "1", name: "Kitchen", cleanOrder: 1, visibility: "visible", preferences: {suctionLevel: 2, waterVolume: 3, cleaningTimes: 1}},
            {id: "2", name: "Hall", cleanOrder: 2, visibility: "visible", preferences: {suctionLevel: 3, waterVolume: 2, cleaningTimes: 1}},
            {id: "3", name: "Guest room", cleanOrder: 3, visibility: "hidden", preferences: {suctionLevel: 1, waterVolume: 1, cleaningTimes: 2}}
        ];
    }

    async getState() {
        return {
            segments: this.segments.map(segment => ({
                ...segment,
                preferences: segment.preferences ? {...segment.preferences} : undefined
            }))
        };
    }

    async setSegmentOrder(segmentIds) {
        const knownIds = this.segments.map(segment => segment.id);

        if (segmentIds.length !== knownIds.length || segmentIds.some(segmentId => !knownIds.includes(segmentId))) {
            throw new Error("Clean order must include every mock segment exactly once.");
        }

        this.segments.forEach(segment => {
            segment.cleanOrder = segmentIds.indexOf(segment.id) + 1;
        });
    }

    async setSegmentPreference(segmentId, key, value) {
        const segment = this.getSegment(segmentId);

        segment.preferences = {
            ...(segment.preferences ?? {}),
            [key]: value
        };
    }

    async setSegmentVisibility(segmentId, visibility) {
        const segment = this.getSegment(segmentId);

        segment.visibility = visibility;
    }

    getSegment(segmentId) {
        const segment = this.segments.find(segment => segment.id === segmentId);

        if (!segment) {
            throw new Error(`Unknown segment '${segmentId}'.`);
        }

        return segment;
    }
}

module.exports = MockSegmentPreferencesCapability;
