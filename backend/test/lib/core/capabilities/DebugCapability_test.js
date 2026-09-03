const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const DebugCapability = require("../../../../lib/core/capabilities/DebugCapability");
const entities = require("../../../../lib/entities");


const makeCapability = status => {
    const calls = [];
    const robot = {
        miotHelper: {
            readProperty: async (siid, piid) => {
                calls.push({type: "read", siid: siid, piid: piid});
                return 1;
            },
            writeProperty: async (siid, piid, value) => {
                calls.push({type: "write", siid: siid, piid: piid, value: value});
            },
            executeAction: async (siid, aiid, params) => {
                calls.push({type: "action", siid: siid, aiid: aiid, params: params});
                return {code: 0};
            }
        },
        dreameMapState: {selectedMapId: 64},
        uploadedFDSObjectsByName: new Map([["fresh-object", Buffer.from("fresh data")]]),
        getUploadedFDSData: objectName => robot.uploadedFDSObjectsByName.get(objectName),
        state: {
            map: {
                metaData: {dreameSavedMapId: "64"},
                size: {x: 1, y: 1},
                pixelSize: 5,
                layers: [
                    {
                        type: "segment",
                        metaData: {
                            segmentId: "8",
                            name: "Understairs",
                            cleanOrder: 1,
                            dreameVisibility: true,
                            dreameCleanSet: [3, 5, 2, 1, 2, 546]
                        },
                        dimensions: {pixelCount: 10}
                    }
                ]
            },
            getFirstMatchingAttribute: () => new entities.state.attributes.StatusStateAttribute({
                value: status,
                flag: entities.state.attributes.StatusStateAttribute.FLAG.NONE
            })
        }
    };

    return {capability: new DebugCapability({robot: robot}), calls: calls};
};

describe("DebugCapability", function() {
    it("should read MIOT properties", async function() {
        const {capability, calls} = makeCapability("docked");

        assert.equal((await capability.execute({action: "readProperty", siid: 4, piid: 26})), 1);
        assert.deepEqual(calls, [{type: "read", siid: 4, piid: 26}]);
    });

    it("should block writes while active", async function() {
        const {capability} = makeCapability("cleaning");

        await assert.rejects(
            capability.execute({action: "writeProperty", siid: 4, piid: 26, value: 1}),
            {message: "Debug write/action blocked while robot status is 'cleaning'."}
        );
    });

    it("should allow forced writes while active", async function() {
        const {capability, calls} = makeCapability("cleaning");

        await capability.execute({action: "writeProperty", siid: 4, piid: 26, value: 1, force: true});
        assert.deepEqual(calls, [{type: "write", siid: 4, piid: 26, value: 1}]);
    });

    it("should expose a compact current map summary", async function() {
        const {capability} = makeCapability("docked");

        assert.deepEqual((await capability.execute({action: "getCurrentMapSummary"})), {
            metaData: {dreameSavedMapId: "64"},
            size: {x: 1, y: 1},
            pixelSize: 5,
            segments: [{
                id: "8",
                name: "Understairs",
                cleanOrder: 1,
                visible: true,
                dreameCleanSet: [3, 5, 2, 1, 2, 546],
                dimensions: {pixelCount: 10}
            }]
        });
    });

    it("should list uploaded FDS objects", async function() {
        const {capability} = makeCapability("docked");

        assert.deepEqual((await capability.execute({action: "listUploadedFDSObjects"})), [{
            objectName: "fresh-object",
            length: 10,
            sha256: "73100873e8fa0c108a73267872980ef2df05a99d768d68359f41053e4fb71856"
        }]);
    });

    it("should return uploaded FDS object data as base64", async function() {
        const {capability} = makeCapability("docked");

        assert.deepEqual((await capability.execute({action: "getUploadedFDSObject", objectName: "fresh-object"})), {
            objectName: "fresh-object",
            length: 10,
            sha256: "73100873e8fa0c108a73267872980ef2df05a99d768d68359f41053e4fb71856",
            base64: "ZnJlc2ggZGF0YQ=="
        });
    });
});
