const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DreameMapSegmentMaterialControlCapability = require("../../../../lib/robots/dreame/capabilities/DreameMapSegmentMaterialControlCapability");
const DreameValetudoRobot = require("../../../../lib/robots/dreame/DreameValetudoRobot");
const MapLayer = require("../../../../lib/entities/map/MapLayer");
const RobotFirmwareError = require("../../../../lib/core/RobotFirmwareError");
const ValetudoMap = require("../../../../lib/entities/map/ValetudoMap");
const ValetudoMapSegment = require("../../../../lib/entities/core/ValetudoMapSegment");


const MIOT_ACTIONS = {
    map_edit: {
        siid: 6,
        aiid: 1
    }
};

const MIOT_PROPERTIES = {
    mapDetails: {
        piid: 2
    },
    actionResult: {
        piid: 6
    }
};

const makeSegmentLayer = (segmentId, metaData) => {
    return new MapLayer({
        type: MapLayer.TYPE.SEGMENT,
        pixels: [segmentId, segmentId],
        metaData: {
            segmentId: segmentId.toString(),
            ...metaData
        }
    });
};

const makeCapability = (sendResultCode = 0) => {
    const calls = {
        mapEditPayloads: [],
        pollMap: 0
    };
    const robot = Object.assign(Object.create(DreameValetudoRobot.prototype), {
        dreameMapState: {
            knownMapIds: [64, 68]
        },
        state: {
            map: new ValetudoMap({
                metaData: {
                    dreameRismMapId: 64
                },
                size: {x: 100, y: 100},
                pixelSize: 5,
                layers: [
                    makeSegmentLayer(4, {
                        material: MapLayer.MATERIAL.WOOD_HORIZONTAL,
                        dreameMaterial: 1,
                        dreameMaterialDirection: 0
                    }),
                    makeSegmentLayer(5, {
                        material: MapLayer.MATERIAL.WOOD_VERTICAL,
                        dreameMaterial: 1,
                        dreameMaterialDirection: 90
                    }),
                    makeSegmentLayer(7, {
                        material: MapLayer.MATERIAL.TILE,
                        dreameMaterial: 2
                    }),
                    makeSegmentLayer(9, {
                        material: MapLayer.MATERIAL.WOOD_VERTICAL
                    })
                ],
                entities: []
            })
        },
        sendDreameMapEditAction: async (payload, miotActions, miotProperties, options) => {
            calls.mapEditPayloads.push({
                payload: payload,
                miotActions: miotActions,
                miotProperties: miotProperties,
                options: options
            });

            return sendResultCode;
        },
        pollMap: () => {
            calls.pollMap++;
        }
    });

    return {
        calls: calls,
        capability: new DreameMapSegmentMaterialControlCapability({
            robot: robot,
            supportedMaterials: [
                MapLayer.MATERIAL.GENERIC,
                MapLayer.MATERIAL.WOOD,
                MapLayer.MATERIAL.WOOD_HORIZONTAL,
                MapLayer.MATERIAL.WOOD_VERTICAL,
                MapLayer.MATERIAL.TILE
            ],
            miot_actions: MIOT_ACTIONS,
            miot_properties: MIOT_PROPERTIES
        })
    };
};

describe("DreameMapSegmentMaterialControlCapability", function() {
    it("should send a full nsm table and preserve existing raw material metadata", async function() {
        const {capability, calls} = makeCapability();

        await capability.setMaterial(new ValetudoMapSegment({id: "5"}), MapLayer.MATERIAL.TILE);

        assert.equal(calls.mapEditPayloads.length, 1);
        assert.deepEqual(calls.mapEditPayloads[0].payload, {
            nsm: {
                "4": {
                    material: 1,
                    direction: 0
                },
                "5": {
                    material: 2
                },
                "7": {
                    material: 2
                },
                "9": {
                    material: 1,
                    direction: 90
                }
            }
        });
        assert.equal(calls.mapEditPayloads[0].miotActions, MIOT_ACTIONS);
        assert.equal(calls.mapEditPayloads[0].miotProperties, MIOT_PROPERTIES);
        assert.deepEqual(calls.mapEditPayloads[0].options, {timeout: 5000});
        assert.equal(calls.pollMap, 1);
    });

    it("should preserve current direction for plain wood target material when known", async function() {
        const {capability, calls} = makeCapability();

        await capability.setMaterial(new ValetudoMapSegment({id: "5"}), MapLayer.MATERIAL.WOOD);

        assert.deepEqual(calls.mapEditPayloads[0].payload.nsm["5"], {
            material: 1,
            direction: 90
        });
    });

    it("should target only the authoritative current saved map", async function() {
        const {capability, calls} = makeCapability();

        await capability.setMaterial(new ValetudoMapSegment({id: "5"}), MapLayer.MATERIAL.TILE, "64");

        assert.equal(calls.mapEditPayloads[0].payload.mapid, 64);
        await assert.rejects(
            capability.setMaterial(new ValetudoMapSegment({id: "5"}), MapLayer.MATERIAL.TILE, "68"),
            {message: "No full editable saved map available for map '68'."}
        );
        assert.equal(calls.mapEditPayloads.length, 1);
    });

    it("should reject a target segment that is not present in the current map", async function() {
        const {capability, calls} = makeCapability();

        await assert.rejects(
            capability.setMaterial(new ValetudoMapSegment({id: "99"}), MapLayer.MATERIAL.TILE),
            {message: "Unknown segment '99'."}
        );
        assert.equal(calls.mapEditPayloads.length, 0);
    });

    it("should throw firmware errors for non-zero result codes", async function() {
        const {capability} = makeCapability(7);

        try {
            await capability.setMaterial(new ValetudoMapSegment({id: "5"}), MapLayer.MATERIAL.TILE);
            throw new Error("Expected setMaterial to throw");
        } catch (e) {
            assert.ok(e instanceof RobotFirmwareError);
        }
    });
});
