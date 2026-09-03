const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameSegmentPreferencesCapability = require("../../../../lib/robots/dreame/capabilities/DreameSegmentPreferencesCapability");
const DreameValetudoRobot = require("../../../../lib/robots/dreame/DreameValetudoRobot");
const entities = require("../../../../lib/entities");
const mapEntities = require("../../../../lib/entities/map");
const RobotFirmwareError = require("../../../../lib/core/RobotFirmwareError");


const makeCapability = (resultCode = 0, status = entities.state.attributes.StatusStateAttribute.VALUE.DOCKED) => {
    const calls = {
        payloads: []
    };
    const robot = Object.assign(Object.create(DreameValetudoRobot.prototype), {
        dreameMapState: {
            knownMapIds: [64]
        },
        state: {
            map: new mapEntities.ValetudoMap({
                metaData: {dreameRismMapId: 64},
                size: {x: 10, y: 10},
                pixelSize: 5,
                layers: [
                    new mapEntities.MapLayer({
                        type: mapEntities.MapLayer.TYPE.SEGMENT,
                        pixels: [1, 1],
                        metaData: {
                            segmentId: "5",
                            name: "Kitchen",
                            cleanOrder: 2,
                            dreameCleanSet: [3, 16, 2, 2, 0, 33],
                            dreameSuctionLevel: 3,
                            dreameWaterVolume: 16,
                            dreameCleaningTimes: 2,
                            dreameCleaningMode: 0,
                            dreameMoppingSettings: 33,
                            dreameVisibility: true
                        }
                    }),
                    new mapEntities.MapLayer({
                        type: mapEntities.MapLayer.TYPE.SEGMENT,
                        pixels: [2, 2],
                        metaData: {
                            segmentId: "7",
                            name: "Hall",
                            cleanOrder: 1,
                            dreameCleanSet: [1, 10, 1, 1, 2, 546],
                            dreameSuctionLevel: 1,
                            dreameWaterVolume: 10,
                            dreameCleaningTimes: 1,
                            dreameCleaningMode: 2,
                            dreameMoppingSettings: 546,
                            dreameVisibility: false
                        }
                    }),
                    new mapEntities.MapLayer({
                        type: mapEntities.MapLayer.TYPE.SEGMENT,
                        pixels: [3, 3],
                        metaData: {segmentId: "16", name: "Unordered"}
                    }),
                    new mapEntities.MapLayer({
                        type: mapEntities.MapLayer.TYPE.WALL,
                        pixels: [4, 4]
                    })
                ],
                entities: []
            }),
            getFirstMatchingAttribute: () => {
                return {value: status};
            }
        },
        sendDreameMapEditAction: async (payload, miotActions, miotProperties, options) => {
            calls.payloads.push({
                payload: payload,
                miotActions: miotActions,
                miotProperties: miotProperties,
                options: options
            });
            return resultCode;
        },
        pollMap: () => undefined
    });

    return {
        capability: new DreameSegmentPreferencesCapability({
            robot: robot,
            miot_actions: {
                map_edit: {
                    siid: 6,
                    aiid: 2
                }
            },
            miot_properties: {
                mapDetails: {
                    piid: 4
                },
                actionResult: {
                    piid: 6
                }
            }
        }),
        calls: calls,
        robot: robot
    };
};

describe("DreameSegmentPreferencesCapability", function() {
    it("should expose segment clean order from the current map", async function() {
        const {capability} = makeCapability();

        assert.deepEqual((await capability.getState()), {
            segments: [
                {
                    id: "7",
                    name: "Hall",
                    cleanOrder: 1,
                    visibility: "hidden",
                    preferences: {
                        suctionLevel: 1,
                        waterVolume: 10,
                        cleaningTimes: 1,
                        cleaningMode: 2,
                        moppingSettings: 546
                    }
                },
                {
                    id: "5",
                    name: "Kitchen",
                    cleanOrder: 2,
                    visibility: "visible",
                    preferences: {
                        suctionLevel: 3,
                        waterVolume: 16,
                        cleaningTimes: 2,
                        cleaningMode: 0,
                        moppingSettings: 33
                    }
                }
            ]
        });
    });

    it("should save persistent segment clean order", async function() {
        const {capability, calls} = makeCapability();

        await capability.setSegmentOrder(["5", "7"]);

        assert.deepEqual(calls.payloads[0].payload, {cleanOrder: [5, 7]});
        assert.deepEqual(calls.payloads[0].miotActions, {map_edit: {siid: 6, aiid: 2}});
        assert.deepEqual(calls.payloads[0].miotProperties, {
            mapDetails: {piid: 4},
            actionResult: {piid: 6}
        });
        assert.deepEqual(calls.payloads[0].options, {timeout: 5000});
    });

    it("should target saved maps by explicit map id", async function() {
        const {capability, calls} = makeCapability();

        await capability.setSegmentOrder(["5", "7"], "64");

        assert.deepEqual(calls.payloads[0].payload, {cleanOrder: [5, 7], mapid: 64});
        await assert.rejects(capability.setSegmentOrder(["5", "7"], "68"), {
            message: "No full editable saved map available for map '68'."
        });
        assert.equal(calls.payloads.length, 1);
    });

    it("should reject unknown segment ids before sending a firmware command", async function() {
        const {capability, calls} = makeCapability();

        try {
            await capability.setSegmentOrder(["5", "99"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.equal(e.message, "Unknown segment '99'.");
        }

        assert.equal(calls.payloads.length, 0);
    });

    it("should reject duplicate segment ids before sending a firmware command", async function() {
        const {capability, calls} = makeCapability();

        try {
            await capability.setSegmentOrder(["5", "5"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.equal(e.message, "Duplicate segment '5'.");
        }

        assert.equal(calls.payloads.length, 0);
    });

    it("should reject unordered transient segments in clean order payloads", async function() {
        const {capability, calls} = makeCapability();

        try {
            await capability.setSegmentOrder(["5", "7", "16"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.equal(e.message, "Segment '16' does not have persistent clean order metadata.");
        }

        assert.equal(calls.payloads.length, 0);
    });

    it("should reject incomplete clean order payloads", async function() {
        const {capability, calls} = makeCapability();

        try {
            await capability.setSegmentOrder(["5"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.equal(e.message, "Clean order must include every ordered segment exactly once.");
        }

        assert.equal(calls.payloads.length, 0);
    });

    it("should save persistent segment suction preference with the full cleanset table", async function() {
        const {capability, calls} = makeCapability();

        await capability.setSegmentPreference("7", "suctionLevel", 2);

        assert.deepEqual(calls.payloads[0].payload, {
            customeClean: [
                [5, 3, 16, 2, 0, 33],
                [7, 2, 10, 1, 2, 546]
            ]
        });
    });

    it("should reject unknown segment preference keys before sending a firmware command", async function() {
        const {capability, calls} = makeCapability();

        try {
            await capability.setSegmentPreference("7", "notASetting", 2);
            throw new Error("Expected setSegmentPreference to throw");
        } catch (e) {
            assert.equal(e.message, "Unknown segment preference 'notASetting'.");
        }

        assert.equal(calls.payloads.length, 0);
    });

    it("should reject clean order changes while the robot is active", async function() {
        const {capability} = makeCapability(0, entities.state.attributes.StatusStateAttribute.VALUE.CLEANING);

        try {
            await capability.setSegmentOrder(["5", "7"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.equal(e.message, "Cannot edit segment preferences while the robot is active.");
        }
    });

    it("should throw firmware errors for failed clean order changes", async function() {
        const {capability} = makeCapability(7);

        try {
            await capability.setSegmentOrder(["5", "7"]);
            throw new Error("Expected setSegmentOrder to throw");
        } catch (e) {
            assert.ok(e instanceof RobotFirmwareError);
        }
    });

    it("should save segment visibility", async function() {
        const {capability, calls} = makeCapability();

        await capability.setSegmentVisibility("5", "hidden");

        assert.deepEqual(calls.payloads[0].payload, {delsr: [5, 7]});
    });
});
