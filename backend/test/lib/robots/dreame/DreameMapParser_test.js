const assert = require("node:assert");
const fs = require("fs").promises;
const path = require("path");
const zlib = require("zlib");
const { describe, it } = require("node:test");

const DreameMapParser = require("../../../../lib/robots/dreame/DreameMapParser");
const { assertParsedMap } = require("../../../helpers/map");

describe("DreameMapParser", () => {

    it("preserves Dreame map ids and raw material metadata", async () => {
        const header = Buffer.alloc(27);
        const image = Buffer.from([5 << 2]);
        const additionalData = Buffer.from(JSON.stringify({
            seg_inf: {
                "5": {
                    material: 1,
                    direction: 90
                }
            }
        }));

        header.writeInt16LE(123, 0);
        header.writeInt16LE(456, 2);
        header.writeInt8(73, 4);
        header.writeInt16LE(32767, 5);
        header.writeInt16LE(32767, 7);
        header.writeInt16LE(0, 9);
        header.writeInt16LE(32767, 11);
        header.writeInt16LE(32767, 13);
        header.writeInt16LE(0, 15);
        header.writeInt16LE(50, 17);
        header.writeInt16LE(1, 19);
        header.writeInt16LE(1, 21);
        header.writeInt16LE(0, 23);
        header.writeInt16LE(0, 25);

        const data = Buffer.concat([header, image, additionalData]);
        const actual = await DreameMapParser.PARSE(data);
        assert.notStrictEqual(actual, null);

        const segmentLayer = actual.layers.find(layer => {
            return layer.metaData.segmentId === "5";
        });

        assert.notStrictEqual(segmentLayer, undefined);
        assert.strictEqual(actual.metaData.dreameMapId, 123);
        assert.strictEqual(actual.metaData.dreameFrameId, 456);
        assert.strictEqual(actual.metaData.dreameMapSource, "regular");
        assert.strictEqual(segmentLayer.metaData.material, "wood_vertical");
        assert.strictEqual(segmentLayer.metaData.dreameMaterial, 1);
        assert.strictEqual(segmentLayer.metaData.dreameMaterialDirection, 90);
    });

    it("merges outer Dreame segment preferences into RISM segment layers", async () => {
        const makeMapBuffer = (id, image, additionalData) => {
            const header = Buffer.alloc(27);

            header.writeInt16LE(id, 0);
            header.writeInt16LE(456, 2);
            header.writeInt8(73, 4);
            header.writeInt16LE(32767, 5);
            header.writeInt16LE(32767, 7);
            header.writeInt16LE(0, 9);
            header.writeInt16LE(32767, 11);
            header.writeInt16LE(32767, 13);
            header.writeInt16LE(0, 15);
            header.writeInt16LE(50, 17);
            header.writeInt16LE(image.length, 19);
            header.writeInt16LE(1, 21);
            header.writeInt16LE(0, 23);
            header.writeInt16LE(0, 25);

            return Buffer.concat([header, image, Buffer.from(JSON.stringify(additionalData))]);
        };
        const encodeMap = (data) => {
            return zlib.deflateSync(data).toString("base64").replace(/\//g, "_").replace(/\+/g, "-");
        };
        const rismMap = makeMapBuffer(68, Buffer.from([5]), {seg_inf: {"5": {}}});
        const currentMap = makeMapBuffer(2, Buffer.from([1]), {
            ris: 2,
            rism: encodeMap(rismMap),
            cleanset: {"5": [3, 16, 2, 2, 0, 33]}
        });

        const actual = await DreameMapParser.PARSE(currentMap);
        assert.notStrictEqual(actual, null);

        const segment5 = actual.layers.find(layer => layer.metaData.segmentId === "5");

        assert.notStrictEqual(segment5, undefined);
        assert.strictEqual(actual.metaData.dreameRismMapId, 68);
        assert.deepStrictEqual(segment5.metaData.dreameCleanSet, [3, 16, 2, 2, 0, 33]);
        assert.strictEqual(segment5.metaData.dreameSuctionLevel, 3);
        assert.strictEqual(segment5.metaData.dreameWaterVolume, 16);
        assert.strictEqual(segment5.metaData.dreameCleaningTimes, 2);
    });

    it("preserves Dreame segment preference metadata", async () => {
        const header = Buffer.alloc(27);
        const image = Buffer.from([5 << 2, 7 << 2]);
        const additionalData = Buffer.from(JSON.stringify({
            seg_inf: {
                "5": {},
                "7": {}
            },
            cleanareaorder: [
                {"7": 1},
                {"5": 2}
            ],
            cleanset: {
                "5": [3, 16, 2, 2, 0, 33],
                "7": [1, 10, 1, 1, 2, 546]
            },
            delsr: [7]
        }));

        header.writeInt16LE(123, 0);
        header.writeInt16LE(456, 2);
        header.writeInt8(73, 4);
        header.writeInt16LE(32767, 5);
        header.writeInt16LE(32767, 7);
        header.writeInt16LE(0, 9);
        header.writeInt16LE(32767, 11);
        header.writeInt16LE(32767, 13);
        header.writeInt16LE(0, 15);
        header.writeInt16LE(50, 17);
        header.writeInt16LE(2, 19);
        header.writeInt16LE(1, 21);
        header.writeInt16LE(0, 23);
        header.writeInt16LE(0, 25);

        const data = Buffer.concat([header, image, additionalData]);
        const actual = await DreameMapParser.PARSE(data);
        assert.notStrictEqual(actual, null);

        const segment7 = actual.layers.find(layer => layer.metaData.segmentId === "7");
        const segment5 = actual.layers.find(layer => layer.metaData.segmentId === "5");

        assert.notStrictEqual(segment7, undefined);
        assert.notStrictEqual(segment5, undefined);
        assert.strictEqual(segment7.metaData.cleanOrder, 1);
        assert.deepStrictEqual(segment7.metaData.dreameCleanSet, [1, 10, 1, 1, 2, 546]);
        assert.strictEqual(segment7.metaData.dreameSuctionLevel, 1);
        assert.strictEqual(segment7.metaData.dreameWaterVolume, 10);
        assert.strictEqual(segment7.metaData.dreameCleaningTimes, 1);
        assert.strictEqual(segment7.metaData.dreameCleaningMode, 2);
        assert.strictEqual(segment7.metaData.dreameMoppingSettings, 546);
        assert.strictEqual(segment7.metaData.dreameVisibility, false);

        assert.strictEqual(segment5.metaData.cleanOrder, 2);
        assert.deepStrictEqual(segment5.metaData.dreameCleanSet, [3, 16, 2, 2, 0, 33]);
        assert.strictEqual(segment5.metaData.dreameVisibility, true);
    });

    it("parses D9 FW 1058 no-segment map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/d9_1058_no_segments.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/d9_1058_no_segments.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(data);

        assertParsedMap(actual, expected);
    });


    it("parses D9 FW 1058 segment map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/d9_1058_with_segments.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/d9_1058_with_segments.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(data);

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses D9 FW 1058 \"custom named segment\" map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/d9_1058_with_custom_named_segments.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/d9_1058_with_custom_named_segments.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses D9 FW 1093 \"huge\" map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/d9_1093_huge.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/d9_1093_huge.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses Z10 FW 1056 map with virtual restrictions correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/z10_1056_virtual_restrictions.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/z10_1056_virtual_restrictions.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses Z10 FW 1056 map with paths correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/z10_1056_paths.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/z10_1056_paths.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("preprocesses & does not parse Z10 FW 1156 super minimal map", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/z10_1156_super_minimal.bin"));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assert.strictEqual(actual, null);
    });

    it("pre-processes & parses 1C FW 1096 \"zoned-cleanup in progress\" map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/1c_1096_zonedcleanup.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/1c_1096_zonedcleanup.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses 1C FW 1096 \"full cleanup in progress\" map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/1c_1096_fullcleanup.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/1c_1096_fullcleanup.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses 1C FW 1096 \"area cleanup in progress\" map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/1c_1096_areacleanup.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/1c_1096_areacleanup.json"), { encoding: "utf-8" }));

        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });


    it("pre-processes & parses 1C FW 1096 map with virtual wall & a no-go zone correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/1c_1096_virtualwall_and_forbidden_zone.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/1c_1096_virtualwall_and_forbidden_zone.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses L10S Ultra FW 1058 map with goto target correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/l10su_1058_goto_target.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/l10su_1058_goto_target.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses L10S Ultra FW 1121 map with new path correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/l10su_1121_new_path.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/l10su_1121_new_path.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses L10S Ultra FW 1121 map with carpet correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/l10su_1121_carpet.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/l10su_1121_carpet.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses monastery map with left cutoff correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/misc_monastery_with_cutoff.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/misc_monastery_with_cutoff.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses X10 Plus FW 1104 map with obstacle correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/x10plus_1104_with_obstacle.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/x10plus_1104_with_obstacle.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });

    it("pre-processes & parses L10S Ultra FW 3031 giant map correctly", async () => {
        const data = await fs.readFile(path.join(__dirname, "/res/map/l10su_3031_giant.bin"));
        const expected = JSON.parse(await fs.readFile(path.join(__dirname, "/res/map/l10su_3031_giant.json"), { encoding: "utf-8" }));
        const actual = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(data));

        assertParsedMap(actual, expected);
    });
});
