const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { describe, it } = require("node:test");

const DreameMapParser = require("../../../../lib/robots/dreame/DreameMapParser");
const DreameValetudoRobot = require("../../../../lib/robots/dreame/DreameValetudoRobot");
const mapEntities = require("../../../../lib/entities/map");
const ValetudoRobot = require("../../../../lib/core/ValetudoRobot");


describe("Dreame map edit payload helpers", function() {
    const makeRobot = (dreameMapState) => {
        const robot = Object.create(DreameValetudoRobot.prototype);

        robot.dreameMapState = dreameMapState;

        return robot;
    };

    it("should send only the map id explicitly authorized by the caller", async function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: [64, 68]
        });
        let sentPayload;

        Object.defineProperty(robot, "deviceId", {value: 123});
        robot.sendCommand = async(method, parameters) => {
            sentPayload = JSON.parse(parameters.in[0].value);

            return {siid: 6, aiid: 2, out: [{piid: 2, value: 0}]};
        };

        const result = await robot.sendDreameMapEditAction(
            {cm: {}},
            {map_edit: {siid: 6, aiid: 2}},
            {mapDetails: {piid: 1}, actionResult: {piid: 2}}
        );

        assert.equal(result, 0);
        assert.deepEqual(sentPayload, {cm: {}});
    });

    it("should prepare explicit edits only for the authoritative current saved map", async function() {
        const map = new mapEntities.ValetudoMap({
            metaData: {dreameRismMapId: 64},
            size: {x: 10, y: 10},
            pixelSize: 5,
            layers: [],
            entities: []
        });
        const robot = makeRobot({knownMapIds: [64, 68]});
        robot.state = {map: map};

        const prepared = await robot.prepareDreameMapEdit({cm: {}}, "64");

        assert.equal(prepared.map, map);
        assert.deepEqual(prepared.payload, {cm: {}, mapid: 64});
        await assert.rejects(robot.prepareDreameMapEdit({cm: {}}, "68"), {
            message: "No full editable saved map available for map '68'."
        });
        await assert.rejects(robot.prepareDreameMapEdit({cm: {}}, "64junk"), {
            message: "Unknown map '64junk'."
        });
    });

    it("should prefer Dreame RISM map ids for current map state", function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: []
        });

        robot.state = {
            map: {
                metaData: {
                    dreameMapId: 5,
                    dreameRismMapId: 68
                }
            }
        };
        robot.updateDreameMapStateFromParsedMap(robot.state.map);

        assert.equal(robot.getCurrentDreameSavedMapId(), 68);
        assert.deepEqual(robot.dreameMapState.knownMapIds, [68]);
    });

    it("should not map Dreame map-list indexes without RISM ids as current saved maps", function() {
        const robot = makeRobot({
            selectedMapId: 64,
            knownMapIds: [64, 66, 68]
        });
        robot.state = {
            map: {
                metaData: {
                    dreameMapId: 1
                }
            }
        };

        robot.updateDreameMapStateFromParsedMap(robot.state.map);

        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);
        assert.deepEqual(robot.dreameMapState.knownMapIds, [64, 66, 68]);
    });

    it("should not use saved-map rotation for raw map-list indexes without RISM ids", function() {
        const robot = makeRobot({
            knownMapIds: [64, 68],
            mapInfoById: {
                64: {rotation: 0},
                68: {rotation: 270}
            }
        });

        assert.equal(robot.getDreameMapRotationForParsedMap({metaData: {dreameMapId: 1}}), 0);
    });

    it("should load embedded Dreame backup map ids with divide-map data", function() {
        const originalMapBackupInfoPath = DreameValetudoRobot.MAP_BACKUP_INFO_PATH;
        const originalDivideMapPath = DreameValetudoRobot.DIVIDE_MAP_PATH;
        const mapBackupInfoPath = "/tmp/valetudo-test-map_bak_info.json";
        const divideMapPath = "/tmp/valetudo-test-DivideMap";
        const robot = makeRobot({
            selectedMapId: undefined,
            knownMapIds: [],
            mapInfoById: {}
        });

        fs.writeFileSync(mapBackupInfoPath, JSON.stringify([
            {id: 68, info: [{first: 1}]},
            {id: 62, info: [{first: 1}]}
        ]));
        fs.mkdirSync(`${divideMapPath}/68`, {recursive: true});
        DreameValetudoRobot.MAP_BACKUP_INFO_PATH = mapBackupInfoPath;
        DreameValetudoRobot.DIVIDE_MAP_PATH = divideMapPath;

        try {
            robot.loadEmbeddedDreameMapBackupInfo();
        } finally {
            DreameValetudoRobot.MAP_BACKUP_INFO_PATH = originalMapBackupInfoPath;
            DreameValetudoRobot.DIVIDE_MAP_PATH = originalDivideMapPath;
            fs.unlinkSync(mapBackupInfoPath);
            fs.rmSync(divideMapPath, {recursive: true, force: true});
        }

        assert.deepEqual(robot.dreameMapState.knownMapIds, [68]);
        assert.deepEqual(robot.dreameMapState.mapInfoById, {
            68: {name: undefined}
        });
    });

    it("should load embedded Dreame current map id without adding orphan ids as known saved maps", function() {
        const originalMapInfoPath = DreameValetudoRobot.MAP_INFO_PATH;
        const mapInfoPath = "/tmp/valetudo-test-map_info.bin";
        const robot = makeRobot({
            selectedMapId: undefined,
            knownMapIds: [62, 64],
            mapInfoById: {}
        });

        fs.writeFileSync(mapInfoPath, JSON.stringify({curr_id: 68}));
        DreameValetudoRobot.MAP_INFO_PATH = mapInfoPath;

        try {
            robot.loadEmbeddedDreameMapInfo();
        } finally {
            DreameValetudoRobot.MAP_INFO_PATH = originalMapInfoPath;
            fs.unlinkSync(mapInfoPath);
        }

        assert.equal(robot.dreameMapState.selectedMapId, 68);
        assert.deepEqual(robot.dreameMapState.knownMapIds, [62, 64]);
    });

    it("should parse a fresh current-map firmware object reference", async function() {
        const robot = makeRobot({});
        const rawMap = Buffer.from("raw-map-object");
        const parsedMap = new mapEntities.ValetudoMap({
            metaData: {dreameRismMapId: 68},
            size: {x: 10, y: 10},
            pixelSize: 5,
            layers: [],
            entities: []
        });

        Object.defineProperty(robot, "deviceId", {value: 123});
        robot.miotServices = {
            MAP: {
                SIID: 6,
                ACTIONS: {POLL: {AIID: 1}},
                PROPERTIES: {
                    MAP_DATA: {PIID: 1},
                    CLOUD_FILE_NAME: {PIID: 3}
                }
            }
        };
        robot.sendCommand = async() => ({code: 0, out: [{piid: 3, value: "current-object"}]});
        robot.getUploadedFDSData = objectName => objectName === "current-object" ? rawMap : undefined;
        robot.preprocessAndParseMap = async(data) => {
            assert.equal(data, rawMap);
            robot.state = {map: parsedMap};
        };
        robot.updateDreameMapStateFromParsedMap = () => {};

        await robot.executeMapPoll();

        assert.equal(robot.state.map, parsedMap);
    });

    it("should reject transient map-list indexes as saved-map edit authority", async function() {
        const map = new mapEntities.ValetudoMap({
            metaData: {dreameMapId: 2},
            size: {x: 10, y: 10},
            pixelSize: 5,
            layers: [],
            entities: []
        });
        const robot = makeRobot({
            knownMapIds: [64, 68]
        });
        robot.state = {map: map};

        await assert.rejects(
            robot.getDreameSavedMapForEdit(64),
            {message: "No full editable saved map available for map '64'."}
        );
    });

    it("should expose only the currently loaded full firmware map for saved-map editing", async function() {
        const map = new mapEntities.ValetudoMap({
            metaData: {
                dreameMapId: 3,
                dreameRismMapId: 64
            },
            size: {x: 10, y: 10},
            pixelSize: 5,
            layers: [],
            entities: []
        });
        const robot = makeRobot({
            selectedMapId: 64,
            knownMapIds: [64, 68],
            mapInfoById: {},
            mapPreviewDataById: {},
            mapPreviewCandidates: []
        });

        robot.state = {map: map};

        assert.equal((await robot.getDreameSavedMapForEdit(64)), map);

        try {
            await robot.getDreameSavedMapForEdit(68);
            throw new Error("Expected getDreameSavedMapForEdit to throw");
        } catch (e) {
            assert.equal(e.message, "No full editable saved map available for map '68'.");
        }
    });

    it("should not resolve saved-map editing from stale preview data", async function() {
        const rawMap = fs.readFileSync(path.join(__dirname, "res/map/x10plus_1104_with_obstacle.bin"), {encoding: "utf8"});
        const robot = makeRobot({
            selectedMapId: 4,
            knownMapIds: [4],
            mapInfoById: {},
            mapPreviewDataById: {
                4: {map: rawMap, rotation: 90}
            },
            mapPreviewCandidates: []
        });
        robot.state = {map: ValetudoRobot.DEFAULT_MAP};

        try {
            await robot.getDreameSavedMapForEdit(4);
            throw new Error("Expected getDreameSavedMapForEdit to throw");
        } catch (e) {
            assert.equal(e.message, "No full editable saved map available for map '4'.");
        }
    });

    it("should treat raw map-list indexes without RISM ids as transient maps", function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: [2, 64, 68],
            mapInfoById: {}
        });
        const transientMap = {
            metaData: {
                dreameMapId: 2
            },
            layers: [{compressedPixels: [0, 0, 3000]}]
        };

        assert.equal(robot.getDreameSavedMapIdForParsedMap(transientMap), undefined);
    });

    it("should not let preview candidates add saved-map identities", async function() {
        const originalPreprocess = DreameMapParser.PREPROCESS;
        const originalParse = DreameMapParser.PARSE;
        const robot = makeRobot({
            knownMapIds: [64],
            mapInfoById: {64: {name: "Known map"}},
            mapPreviewDataById: {},
            mapPreviewCandidates: [{map: "preview", name: "Unlisted map"}]
        });
        DreameMapParser.PREPROCESS = async data => data;
        DreameMapParser.PARSE = async() => ({metaData: {dreameRismMapId: 68}});

        try {
            await robot.populateDreameSavedMapPreviewCacheFromCandidates();
        } finally {
            DreameMapParser.PREPROCESS = originalPreprocess;
            DreameMapParser.PARSE = originalParse;
        }

        assert.deepEqual(robot.dreameMapState.knownMapIds, [64]);
        assert.equal(robot.dreameMapState.mapInfoById[68], undefined);
        assert.equal(robot.dreameMapState.mapPreviewDataById[68], undefined);
    });

    it("should derive display-only map-list identity from saved backup map headers", async function() {
        const originalPreprocess = DreameMapParser.PREPROCESS;
        const originalParse = DreameMapParser.PARSE;
        const robot = makeRobot({
            selectedMapId: 64,
            knownMapIds: [64],
            mapInfoById: {64: {name: "Lower floor"}},
            mapPreviewDataById: {},
            mapPreviewCandidates: []
        });
        robot.state = {map: {metaData: {dreameMapId: 66}}};
        DreameMapParser.PREPROCESS = async data => data;
        DreameMapParser.PARSE = async data => ({
            metaData: {dreameMapId: data === "entry-preview" ? 66 : 68}
        });

        try {
            await robot.handleUploadedDreameMapJson(Buffer.from(JSON.stringify({
                curr_id: 64,
                mapstr: [
                    {name: "Entry floor", angle: "180", map: "entry-preview"},
                    {name: "Upper floor", angle: "0", map: "upper-preview"}
                ]
            })), {}, {});
        } finally {
            DreameMapParser.PREPROCESS = originalPreprocess;
            DreameMapParser.PARSE = originalParse;
        }

        assert.deepEqual(robot.dreameMapState.knownMapIds, [66, 68]);
        assert.deepEqual(robot.dreameMapState.mapInfoById, {
            66: {name: "Entry floor", rotation: 180},
            68: {name: "Upper floor", rotation: 0}
        });
        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);
    });

    it("should not expose raw transient map ids as saved maps", function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: [64, 68],
            mapInfoById: {}
        });
        const transientMap = {
            metaData: {
                dreameMapId: 3
            },
            layers: [{compressedPixels: [0, 0, 3000]}]
        };

        assert.equal(robot.getDreameSavedMapIdForParsedMap(transientMap), undefined);
        robot.state = {map: transientMap};
        robot.updateDreameMapStateFromParsedMap(transientMap);

        assert.equal(robot.getCurrentDreameSavedMapId(), undefined);
        assert.deepEqual(robot.dreameMapState.knownMapIds, [64, 68]);
    });

    it("should trust RISM ids when raw map-list indexes are also present", function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: [64, 68],
            mapInfoById: {}
        });
        const parsedMap = {
            metaData: {
                dreameMapId: 2,
                dreameRismMapId: 68
            },
            layers: []
        };

        assert.equal(robot.getDreameSavedMapIdForParsedMap(parsedMap), 68);
    });

    it("should discard stale preview candidates after receiving a fresh Dreame map list", async function() {
        const robot = makeRobot({
            selectedMapId: 64,
            knownMapIds: [64],
            mapInfoById: {64: {name: "Stale map"}},
            mapPreviewDataById: {},
            mapPreviewCandidates: [{mapIndex: 1, name: "Stale map", map: "stale"}]
        });

        await robot.handleUploadedDreameMapJson(Buffer.from(JSON.stringify({
            curr_id: 68,
            mapstr: []
        })), {}, {});

        assert.deepEqual(robot.dreameMapState.mapPreviewCandidates, []);
    });

    it("should prune stale startup map ids that are not decoded from a fresh Dreame map list", async function() {
        const robot = makeRobot({
            selectedMapId: 66,
            knownMapIds: [62, 66],
            mapInfoById: {
                62: {name: undefined},
                66: {name: "Entry floor"}
            }
        });

        await robot.handleUploadedDreameMapJson(Buffer.from(JSON.stringify({
            curr_id: 66,
            mapstr: []
        })), {}, {});

        assert.deepEqual(robot.dreameMapState.knownMapIds, []);
        assert.equal(robot.dreameMapState.mapInfoById[62], undefined);
        assert.equal(robot.dreameMapState.mapInfoById[66], undefined);
    });

    it("should not use stale map rotation when parsed map identity is unavailable", function() {
        const robot = makeRobot({
            mapInfoById: {
                66: {rotation: 90}
            }
        });

        assert.equal(robot.getDreameMapRotationForParsedMap({metaData: {}}), 0);
    });

    it("should rotate parsed map data to the saved-map angle", function() {
        const robot = makeRobot({
            selectedMapId: 68,
            knownMapIds: [68],
            mapInfoById: {
                68: {rotation: 90}
            }
        });
        const map = new mapEntities.ValetudoMap({
            metaData: {
                dreameRismMapId: 68
            },
            size: {x: 100, y: 100},
            pixelSize: 10,
            layers: [
                new mapEntities.MapLayer({
                    type: mapEntities.MapLayer.TYPE.SEGMENT,
                    metaData: {segmentId: "1"},
                    pixels: [2, 2, 4, 2]
                })
            ],
            entities: [
                new mapEntities.PointMapEntity({
                    type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                    points: [20, 20],
                    metaData: {angle: 45}
                })
            ]
        });

        const rotated = robot.applyDreameMapRotation(map, robot.getDreameMapRotationForParsedMap(map));

        assert.equal(rotated.metaData.dreameAppliedRotation, 90);
        assert.deepEqual(DreameValetudoRobot.EXPAND_COMPRESSED_PIXELS(rotated.layers[0].compressedPixels), [
            [3, 1],
            [3, 3]
        ]);
        assert.deepEqual(rotated.entities[0].points, [30, 10]);
        assert.equal(rotated.entities[0].metaData.angle, 135);
    });

    it("should not create artificial runs when recompressing rotated pixels", function() {
        const robot = makeRobot({});
        const map = new mapEntities.ValetudoMap({
            metaData: {},
            size: {x: 100, y: 100},
            pixelSize: 10,
            layers: [
                new mapEntities.MapLayer({
                    type: mapEntities.MapLayer.TYPE.SEGMENT,
                    metaData: {segmentId: "1"},
                    pixels: [
                        1, 1,
                        2, 1,
                        1, 2
                    ]
                })
            ],
            entities: []
        });

        const rotated = robot.applyDreameMapRotation(map, 90);

        assert.equal(rotated.layers[0].dimensions.pixelCount, 3);
        assert.deepEqual(DreameValetudoRobot.EXPAND_COMPRESSED_PIXELS(rotated.layers[0].compressedPixels), [
            [2, 1],
            [2, 2],
            [1, 1]
        ].sort(DreameValetudoRobot.COORDINATE_TUPLE_ASC_SORT));
    });

    it("should rotate already rotated map data by the delta", function() {
        const robot = makeRobot({});
        const map = new mapEntities.ValetudoMap({
            metaData: {
                dreameAppliedRotation: 90
            },
            size: {x: 100, y: 100},
            pixelSize: 10,
            layers: [
                new mapEntities.MapLayer({
                    type: mapEntities.MapLayer.TYPE.SEGMENT,
                    metaData: {segmentId: "1"},
                    pixels: [3, 1, 3, 3]
                })
            ],
            entities: []
        });

        const rotated = robot.applyDreameMapRotation(map, 0);

        assert.equal(rotated.metaData.dreameAppliedRotation, 0);
        assert.deepEqual(DreameValetudoRobot.EXPAND_COMPRESSED_PIXELS(rotated.layers[0].compressedPixels), [
            [2, 2],
            [4, 2]
        ]);
    });

    it("should parse Dreame map rotations from strings", function() {
        assert.equal(DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION("90"), 90);
        assert.equal(DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION("45"), undefined);
    });

});
