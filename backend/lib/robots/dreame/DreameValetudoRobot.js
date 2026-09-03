const fs = require("fs");
const Logger = require("../../Logger");
const mapEntities = require("../../entities/map");

const LinuxWifiScanCapability = require("../common/linuxCapabilities/LinuxWifiScanCapability");
const miioCapabilities = require("../common/miioCapabilities");

const DreameMapParser = require("./DreameMapParser");
const DreameMiotHelper = require("./DreameMiotHelper");

const AttachmentStateAttribute = require("../../entities/state/attributes/AttachmentStateAttribute");
const AttributeSubscriber = require("../../entities/AttributeSubscriber");
const CallbackAttributeSubscriber = require("../../entities/CallbackAttributeSubscriber");
const entities = require("../../entities");
const MiioDummycloudNotConnectedError = require("../../miio/MiioDummycloudNotConnectedError");
const MiioErrorResponseRobotFirmwareError = require("../../miio/MiioErrorResponseRobotFirmwareError");
const MiioValetudoRobot = require("../MiioValetudoRobot");
const MopAttachmentReminderValetudoEvent = require("../../valetudo_events/events/MopAttachmentReminderValetudoEvent");
const PendingMapChangeValetudoEvent = require("../../valetudo_events/events/PendingMapChangeValetudoEvent");
const ValetudoMap = require("../../entities/map/ValetudoMap");
const ValetudoRobotError = require("../../entities/core/ValetudoRobotError");

const stateAttrs = entities.state.attributes;

class DreameValetudoRobot extends MiioValetudoRobot {
    /**
     *
     * @param {object} options
     * @param {import("../../Configuration")} options.config
     * @param {import("../../ValetudoEventStore")} options.valetudoEventStore
     * @param {object} [options.operationModes]
     * @param {number} [options.miotPostWriteDelay]
     * @param {object} options.miotServices
     * @param {object} options.miotServices.MAP
     * @param {number} options.miotServices.MAP.SIID
     * @param {object} options.miotServices.MAP.ACTIONS
     * @param {object} options.miotServices.MAP.ACTIONS.POLL
     * @param {number} options.miotServices.MAP.ACTIONS.POLL.AIID
     * @param {object} options.miotServices.MAP.PROPERTIES
     * @param {object} options.miotServices.MAP.PROPERTIES.MAP_DATA
     * @param {number} options.miotServices.MAP.PROPERTIES.MAP_DATA.PIID
     */
    constructor(options) {
        super(options);
        this.miotHelper = new DreameMiotHelper({robot: this, postWriteDelay: options.miotPostWriteDelay});

        this.operationModes = options.operationModes ?? {};
        this.miotServices = options.miotServices;

        this.dreameMapState = {
            selectedMapId: undefined,
            knownMapIds: [],
            mapInfoById: {},
            mapPreviewDataById: {},
            mapPreviewCandidates: []
        };

        this.loadEmbeddedDreameMapState();

        this.registerCapability(new miioCapabilities.MiioWifiConfigurationCapability({
            robot: this,
            networkInterface: "wlan0"
        }));

        if (this.config.get("embedded") === true) {
            this.registerCapability(new LinuxWifiScanCapability({
                robot: this,
                networkInterface: "wlan0"
            }));
        }
    }

    setEmbeddedParameters() {
        this.deviceConfPath = DreameValetudoRobot.DEVICE_CONF_PATH;
        this.tokenFilePath = DreameValetudoRobot.TOKEN_FILE_PATH;
    }

    async executeMapPoll() {
        let mapPollResult;
        try {
            mapPollResult = await this.sendCommand("action",
                {
                    did: this.deviceId,
                    siid: this.miotServices.MAP.SIID,
                    aiid: this.miotServices.MAP.ACTIONS.POLL.AIID,
                    in: [{
                        piid: 2,
                        value: "{\"frame_type\":\"I\", \"force_type\": 1, \"req_type\": 1}"
                    }]
                },
                {
                    timeout: 7000, // user ack timeout seems to appear after ~6s on the p2028 1156
                    interface: "cloud"
                }
            );
        } catch (e) {
            if (e instanceof MiioErrorResponseRobotFirmwareError && e.response?.message === "user ack timeout") {
                /*
                    Since we're polling IFrames much faster than the regular dreame map, occasionally, the dreame
                    firmware isn't quick enough to respond to our requests.

                    As this is expected, we just ignore that error
                 */
            } else if (e instanceof MiioDummycloudNotConnectedError) {
                /* intentional */
            } else {
                Logger.warn("Error while polling map", e);
            }

            return false;
        }

        if (mapPollResult.code === 0 && Array.isArray(mapPollResult.out)) {
            for (let prop of mapPollResult.out) {
                const mapDataPiid = this.miotServices.MAP.PROPERTIES.MAP_DATA.PIID;
                const cloudFileNamePiid = this.miotServices.MAP.PROPERTIES["CLOUD_FILE_NAME"]?.PIID;

                if (prop.piid === mapDataPiid && prop.value?.length > 15) {
                    try {
                        await this.preprocessAndParseMap(prop.value);
                    } catch (e) {
                        Logger.warn("Error while trying to parse map from miio", e);
                    }
                } else if (prop.piid === cloudFileNamePiid && typeof prop.value === "string" && prop.value.length > 0) {
                    const objectData = this.getDreameMapObjectData(prop.value);

                    if (objectData) {
                        try {
                            await this.preprocessAndParseMap(objectData);
                        } catch (e) {
                            Logger.warn("Error while trying to parse map object from miio", e);
                        }
                    }
                }
            }
        }
    }

    /**
     * Uploaded dreame Maps are actually base64 strings of zlib compressed data with two characters replaced
     *
     * @param {any} data
     * @returns {Promise<Buffer>}
     */
    async preprocessMap(data) {
        const preprocessedData = await DreameMapParser.PREPROCESS(data);

        if (preprocessedData) {
            return preprocessedData;
        } else {
            throw new Error("Invalid map data");
        }
    }

    async parseMap(data) {
        const parsedMap = await DreameMapParser.PARSE(data);

        if (parsedMap instanceof ValetudoMap) {
            const rotatedMap = this.applyDreameMapRotation(
                parsedMap,
                this.getDreameMapRotationForParsedMap(parsedMap)
            );

            if (
                rotatedMap.metaData?.dreamePendingMapChange === true &&
                this.state.map?.metaData?.dreamePendingMapChange !== true
            ) {
                this.valetudoEventStore.raise(new PendingMapChangeValetudoEvent({}));
            }

            this.state.map = rotatedMap;
            this.updateDreameMapStateFromParsedMap(rotatedMap);

            this.emitMapUpdated();
        }

        return this.state.map;
    }

    /**
     * @public
     * @param {Buffer} data
     * @param {object} query implementation specific query parameters
     * @param {object} params implementation specific url parameters
     * @returns {Promise<void>}
     */
    async handleUploadedFDSData(data, query, params) {
        if (
            Buffer.isBuffer(data) &&
            (
                data[0] === 0x7b || data[0] === 0x5b // 0x7b = "{" 0x5b = "["
            )
        ) {
            await this.handleUploadedDreameMapJson(data, query, params);
        } else if (
            Buffer.isBuffer(data) &&
            (
                data[0] === 0x42 && data[1] === 0x5a && data[2] === 0x68 // bzip2 magic bytes
            )
        ) {
            Logger.trace("Received unhandled map backup", {
                query: query,
                params: params
            });
        } else {
            await this.preprocessAndParseMap(data);
        }
    }

    /**
     * @protected
     * @param {Buffer| string} data
     * @returns {Promise<void>}
     */
    async preprocessAndParseMap(data) {
        const preprocessedMap = await this.preprocessMap(data);
        const parsedMap = await this.parseMap(preprocessedMap);

        if (!parsedMap) {
            Logger.warn("Failed to parse uploaded map");
        }
    }

    /**
     * @private
     */
    loadEmbeddedDreameMapState() {
        if (this.config.get("embedded") !== true) {
            return;
        }

        try {
            const mapConfig = JSON.parse(fs.readFileSync(DreameValetudoRobot.MULTI_MAP_CONFIG_PATH, {encoding: "utf8"}));

            if (mapConfig.EnableMultMap === 1) {
                this.loadEmbeddedDreameMapBackupInfo();
                this.loadEmbeddedDreameMapInfo();
            }
        } catch (e) {
            Logger.debug("Unable to read Dreame multimap config", e);
        }
    }

    /**
     * @private
     */
    loadEmbeddedDreameMapBackupInfo() {
        try {
            const mapBackupInfo = JSON.parse(fs.readFileSync(DreameValetudoRobot.MAP_BACKUP_INFO_PATH, {encoding: "utf8"}));

            if (!Array.isArray(mapBackupInfo)) {
                return;
            }

            const knownMapIds = new Set(this.dreameMapState.knownMapIds);
            const mapInfoById = {...this.dreameMapState.mapInfoById};

            mapBackupInfo.forEach(mapBackupEntry => {
                if (!Number.isSafeInteger(mapBackupEntry?.id)) {
                    return;
                }

                if (!fs.existsSync(`${DreameValetudoRobot.DIVIDE_MAP_PATH}/${mapBackupEntry.id}`)) {
                    return;
                }

                knownMapIds.add(mapBackupEntry.id);

                mapInfoById[mapBackupEntry.id] = {
                    ...mapInfoById[mapBackupEntry.id],
                    name: mapInfoById[mapBackupEntry.id]?.name
                };
            });

            this.dreameMapState.knownMapIds = Array.from(knownMapIds).sort((a, b) => a - b);
            this.dreameMapState.mapInfoById = mapInfoById;
        } catch (e) {
            Logger.debug("Unable to read Dreame map backup info", e);
        }
    }

    /**
     * @private
     */
    loadEmbeddedDreameMapInfo() {
        try {
            const mapInfo = JSON.parse(fs.readFileSync(DreameValetudoRobot.MAP_INFO_PATH, {encoding: "utf8"}));

            if (Number.isSafeInteger(mapInfo?.curr_id)) {
                this.dreameMapState.selectedMapId = mapInfo.curr_id;
            }

            if (Array.isArray(mapInfo?.mapstr)) {
                this.dreameMapState.mapPreviewCandidates = mapInfo.mapstr.filter(mapListEntry => {
                    return typeof mapListEntry?.map === "string";
                }).map(mapListEntry => {
                    return {
                        name: mapListEntry.name,
                        rotation: DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION(mapListEntry?.angle),
                        map: mapListEntry.map
                    };
                });
            }
        } catch (e) {
            Logger.debug("Unable to read Dreame map info", e);
        }
    }

    /**
     * @public
     * @param {number} mapId
     * @returns {Promise<ValetudoMap>}
     */
    async getDreameSavedMapPreview(mapId) {
        this.dreameMapState.mapPreviewDataById ??= {};
        await this.populateDreameSavedMapPreviewCacheFromCandidates();

        const previewData = this.dreameMapState.mapPreviewDataById[mapId];

        if (
            !previewData?.map &&
            mapId === this.getCurrentDreameSavedMapId() &&
            this.state.map instanceof ValetudoMap &&
            this.state.map.metaData?.defaultMap !== true
        ) {
            return this.state.map;
        }

        if (!previewData?.map) {
            throw new Error(`No preview available for map '${mapId}'.`);
        }

        const parsedMap = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(previewData.map));

        if (!(parsedMap instanceof ValetudoMap)) {
            throw new Error(`No preview available for map '${mapId}'.`);
        }

        return this.applyDreameMapRotation(
            parsedMap,
            this.dreameMapState.mapInfoById[mapId]?.rotation ?? previewData.rotation ?? 0
        );
    }

    /**
     * @public
     * @param {number} mapId
     * @returns {Promise<ValetudoMap>}
     */
    async getDreameSavedMapForEdit(mapId) {
        if (
            mapId === this.getCurrentDreameSavedMapId() &&
            this.state.map instanceof ValetudoMap &&
            this.state.map.metaData?.defaultMap !== true
        ) {
            return this.state.map;
        }

        throw new Error(`No full editable saved map available for map '${mapId}'.`);
    }

    /**
     * Resolve an optional public map id without allowing saved-map display data to authorize an edit.
     * Calls without a map id preserve the legacy current-map behavior.
     *
     * @public
     * @param {object} payload
     * @param {string|undefined} mapId
     * @returns {Promise<{map: ValetudoMap, payload: object}>}
     */
    async prepareDreameMapEdit(payload, mapId) {
        if (mapId === undefined) {
            return {
                map: this.state.map,
                payload: payload
            };
        }

        if (!/^(0|[1-9]\d*)$/.test(mapId)) {
            throw new Error(`Unknown map '${mapId}'.`);
        }

        const parsedMapId = Number(mapId);

        if (!Number.isSafeInteger(parsedMapId)) {
            throw new Error(`Unknown map '${mapId}'.`);
        }

        return {
            map: await this.getDreameSavedMapForEdit(parsedMapId),
            payload: {
                ...payload,
                mapid: parsedMapId
            }
        };
    }

    /**
     * @private
     * @param {string} objectName
     * @returns {Buffer|undefined}
     */
    getDreameMapObjectData(objectName) {
        if (typeof this.getUploadedFDSData !== "function") {
            return undefined;
        }

        const data = this.getUploadedFDSData(objectName);

        if (Buffer.isBuffer(data)) {
            return data;
        }

        if (typeof data === "string") {
            return Buffer.from(data);
        }

        return undefined;
    }

    /**
     * @private
     * @returns {Promise<void>}
     */
    async populateDreameSavedMapPreviewCacheFromCandidates() {
        if (!Array.isArray(this.dreameMapState.mapPreviewCandidates) || this.dreameMapState.mapPreviewCandidates.length === 0) {
            return;
        }

        this.dreameMapState.mapPreviewDataById ??= {};
        const candidates = this.dreameMapState.mapPreviewCandidates;
        this.dreameMapState.mapPreviewCandidates = [];

        for (const candidate of candidates) {
            try {
                const decodedMap = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(candidate.map));
                const savedMapId = this.getDreameSavedMapIdForPreview(decodedMap);

                if (!Number.isSafeInteger(savedMapId) || !this.dreameMapState.knownMapIds.includes(savedMapId)) {
                    continue;
                }

                this.dreameMapState.mapPreviewDataById[savedMapId] = {
                    map: candidate.map,
                    rotation: candidate.rotation
                };

                this.dreameMapState.mapInfoById[savedMapId] = {
                    ...this.dreameMapState.mapInfoById[savedMapId],
                    name: this.dreameMapState.mapInfoById[savedMapId]?.name ?? candidate.name,
                    rotation: candidate.rotation ?? this.dreameMapState.mapInfoById[savedMapId]?.rotation
                };
            } catch (e) {
                Logger.debug("Unable to parse Dreame saved map preview candidate", e);
            }
        }
    }

    /**
     * @private
     * @param {ValetudoMap} parsedMap
     * @returns {number|undefined}
     */
    getDreameSavedMapIdForParsedMap(parsedMap) {
        const rismMapId = parsedMap?.metaData?.dreameRismMapId;

        return Number.isSafeInteger(rismMapId) ? rismMapId : undefined;
    }

    /**
     * Resolve display-only saved-map previews. Firmware backup maps use the saved-map id as
     * their raw map id, while complete current maps carry it as a RISM map id.
     *
     * @private
     * @param {ValetudoMap} parsedMap
     * @returns {number|undefined}
     */
    getDreameSavedMapIdForPreview(parsedMap) {
        const rismMapId = parsedMap?.metaData?.dreameRismMapId;

        if (Number.isSafeInteger(rismMapId)) {
            return rismMapId;
        }

        const rawMapId = parsedMap?.metaData?.dreameMapId;

        return Number.isSafeInteger(rawMapId) ? rawMapId : undefined;
    }

    /**
     * @private
     * @param {ValetudoMap} parsedMap
     */
    updateDreameMapStateFromParsedMap(parsedMap) {
        const currentMapId = this.getDreameSavedMapIdForParsedMap(parsedMap);

        if (
            Number.isSafeInteger(parsedMap.metaData?.dreameRismMapId) &&
            Number.isSafeInteger(currentMapId) &&
            !this.dreameMapState.knownMapIds.includes(currentMapId)
        ) {
            this.dreameMapState.knownMapIds.push(currentMapId);
            this.dreameMapState.knownMapIds.sort((a, b) => a - b);
        }
    }

    /**
     * @returns {number|undefined}
     */
    getCurrentDreameSavedMapId() {
        if (this.state.map?.metaData?.defaultMap === true) {
            return undefined;
        }

        return this.getDreameSavedMapIdForParsedMap(this.state.map);
    }

    /**
     * @param {number|undefined} mapId
     * @returns {string|undefined}
     */
    getDreameSavedMapName(mapId) {
        if (!Number.isSafeInteger(mapId) || !this.dreameMapState.knownMapIds.includes(mapId)) {
            return undefined;
        }

        const name = this.dreameMapState.mapInfoById[mapId]?.name;

        return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
    }

    /**
     * @private
     * @param {ValetudoMap} parsedMap
     * @returns {number}
     */
    getDreameMapRotationForParsedMap(parsedMap) {
        const currentMapId = this.getDreameSavedMapIdForParsedMap(parsedMap);

        return Number.isSafeInteger(currentMapId) ? this.dreameMapState.mapInfoById[currentMapId]?.rotation ?? 0 : 0;
    }

    /**
     * @public
     * @param {ValetudoMap} map
     * @param {number} targetRotation
     * @returns {ValetudoMap}
     */
    applyDreameMapRotation(map, targetRotation) {
        const rotation = DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION(targetRotation) ?? 0;
        const appliedRotation = DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION(map.metaData?.dreameAppliedRotation) ?? 0;
        const delta = (rotation - appliedRotation + 360) % 360;

        if (delta === 0) {
            map.metaData.dreameAppliedRotation = rotation;
            return map;
        }

        const pixelBounds = DreameValetudoRobot.GET_LAYER_PIXEL_BOUNDS(map.layers);
        const cmBounds = {
            x: {
                min: pixelBounds.x.min * map.pixelSize,
                max: pixelBounds.x.max * map.pixelSize
            },
            y: {
                min: pixelBounds.y.min * map.pixelSize,
                max: pixelBounds.y.max * map.pixelSize
            }
        };
        const rotatePixelPoint = (x, y) => {
            return DreameValetudoRobot.ROTATE_POINT_AROUND_BOUNDS(x, y, pixelBounds, delta);
        };
        const rotateCMPoint = (x, y) => {
            return DreameValetudoRobot.ROTATE_POINT_AROUND_BOUNDS(x, y, cmBounds, delta);
        };

        return new mapEntities.ValetudoMap({
            metaData: {
                ...map.metaData,
                dreameAppliedRotation: rotation
            },
            size: map.size,
            pixelSize: map.pixelSize,
            layers: map.layers.map(layer => {
                const rotatedPixels = DreameValetudoRobot.EXPAND_COMPRESSED_PIXELS(layer.compressedPixels).map(pixel => {
                    return rotatePixelPoint(pixel[0], pixel[1]);
                });

                return new mapEntities.MapLayer({
                    type: layer.type,
                    metaData: {...layer.metaData},
                    pixels: rotatedPixels.sort(DreameValetudoRobot.COORDINATE_TUPLE_ASC_SORT).flat()
                });
            }),
            entities: map.entities.map(entity => {
                const rotatedPoints = [];

                for (let i = 0; i < entity.points.length; i += 2) {
                    const p = rotateCMPoint(entity.points[i], entity.points[i + 1]);

                    rotatedPoints.push(p[0], p[1]);
                }

                const entityOptions = {
                    type: entity.type,
                    metaData: {
                        ...entity.metaData,
                        angle: entity.metaData?.angle !== undefined ? (entity.metaData.angle + delta) % 360 : undefined
                    },
                    points: rotatedPoints
                };

                if (entity instanceof mapEntities.PointMapEntity) {
                    return new mapEntities.PointMapEntity(entityOptions);
                } else if (entity instanceof mapEntities.LineMapEntity) {
                    return new mapEntities.LineMapEntity(entityOptions);
                } else if (entity instanceof mapEntities.PolygonMapEntity) {
                    return new mapEntities.PolygonMapEntity(entityOptions);
                } else if (entity instanceof mapEntities.PathMapEntity) {
                    return new mapEntities.PathMapEntity(entityOptions);
                } else {
                    throw new Error(`Unsupported map entity type ${entity.type}`);
                }
            })
        });
    }

    /**
     * @private
     * @param {Buffer} data
     * @param {object} query
     * @param {object} params
     * @returns {Promise<void>}
     */
    async handleUploadedDreameMapJson(data, query, params) {
        const rawJson = data.toString();
        let parsedJson;

        try {
            parsedJson = JSON.parse(rawJson);
        } catch (e) {
            Logger.trace("Received unhandled multi-map json", {
                query: query,
                params: params,
                data: rawJson
            });
            return;
        }

        const mapList = Array.isArray(parsedJson?.mapstr) ? parsedJson.mapstr : undefined;

        if (!mapList) {
            Logger.trace("Received unhandled multi-map json", {
                query: query,
                params: params,
                data: rawJson
            });
            return;
        }

        this.dreameMapState.mapPreviewDataById ??= {};
        this.dreameMapState.mapPreviewCandidates = [];
        const knownMapIds = new Set();
        const mapInfoById = {...this.dreameMapState.mapInfoById};

        if (Number.isSafeInteger(parsedJson.curr_id)) {
            this.dreameMapState.selectedMapId = parsedJson.curr_id;
        }

        for (const mapListEntry of mapList) {
            if (mapListEntry?.map) {
                try {
                    const decodedMap = await DreameMapParser.PARSE(await DreameMapParser.PREPROCESS(mapListEntry.map));
                    const savedMapId = this.getDreameSavedMapIdForPreview(decodedMap);

                    if (Number.isSafeInteger(savedMapId)) {
                        knownMapIds.add(savedMapId);

                        const rotation = DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION(mapListEntry.angle);

                        mapInfoById[savedMapId] = {
                            ...mapInfoById[savedMapId],
                            name: mapListEntry.name,
                            rotation: rotation ?? mapInfoById[savedMapId]?.rotation
                        };

                        this.dreameMapState.mapPreviewDataById[savedMapId] = {
                            map: mapListEntry.map,
                            rotation: rotation
                        };

                    }
                } catch (e) {
                    Logger.debug("Unable to parse Dreame saved map from map-list json", e);
                }
            }
        }

        this.dreameMapState.knownMapIds = Array.from(knownMapIds).sort((a, b) => a - b);
        this.dreameMapState.mapInfoById = Object.fromEntries(
            Object.entries(mapInfoById).filter(([mapId]) => knownMapIds.has(parseInt(mapId, 10)))
        );
        this.dreameMapState.mapPreviewDataById = Object.fromEntries(
            Object.entries(this.dreameMapState.mapPreviewDataById).filter(([mapId]) => knownMapIds.has(parseInt(mapId, 10)))
        );

        Logger.debug("Updated Dreame map-list state", {
            selectedMapId: this.dreameMapState.selectedMapId,
            knownMapIds: this.dreameMapState.knownMapIds,
            mapInfoById: this.dreameMapState.mapInfoById
        });
    }

    /**
     * @param {object} payload
     * @param {object} miotActions
     * @param {object} miotActions.map_edit
     * @param {number} miotActions.map_edit.siid
     * @param {number} miotActions.map_edit.aiid
     * @param {object} miotProperties
     * @param {object} miotProperties.mapDetails
     * @param {number} miotProperties.mapDetails.piid
     * @param {object} miotProperties.actionResult
     * @param {number} miotProperties.actionResult.piid
     * @param {object} [options]
     * @param {number} [options.timeout]
     * @returns {Promise<number|undefined>}
     */
    async sendDreameMapEditAction(payload, miotActions, miotProperties, options = {}) {
        Logger.debug("Sending Dreame map edit payload", payload);

        const res = await this.sendCommand("action",
            {
                did: this.deviceId,
                siid: miotActions.map_edit.siid,
                aiid: miotActions.map_edit.aiid,
                in: [
                    {
                        piid: miotProperties.mapDetails.piid,
                        value: JSON.stringify(payload)
                    }
                ]
            },
            {timeout: options.timeout}
        );

        if (
            res && res.siid === miotActions.map_edit.siid &&
            res.aiid === miotActions.map_edit.aiid &&
            Array.isArray(res.out) && res.out.length === 1 &&
            res.out[0].piid === miotProperties.actionResult.piid
        ) {
            return res.out[0].value;
        }

        return undefined;
    }

    getManufacturer() {
        return "Dreame";
    }

    startup() {
        super.startup();

        if (this.config.get("embedded") === true) {
            const firmwareVersion = this.getFirmwareVersion();

            if (firmwareVersion.valid) {
                Logger.info("Firmware Version: " + firmwareVersion.arm);
            }
        }
    }

    initInternalSubscriptions() {
        super.initInternalSubscriptions();

        this.state.subscribe(
            new CallbackAttributeSubscriber((eventType,attachment, prevStatus) => {
                if (
                    eventType === AttributeSubscriber.EVENT_TYPE.CHANGE &&
                    attachment.type === AttachmentStateAttribute.TYPE.MOP &&
                    //@ts-ignore
                    attachment.attached === false
                ) {
                    try {
                        this.valetudoEventStore.setProcessed(MopAttachmentReminderValetudoEvent.ID);
                    } catch (e) {
                        //intentional
                    }
                }
            }),
            {attributeClass: AttachmentStateAttribute.name}
        );
    }

    /**
     * @private
     * @returns {{arm: string, valid: boolean}}
     */
    getFirmwareVersion() {
        const firmwareVersion = {
            arm: "???",
            valid: false
        };

        try {
            const os_release = fs.readFileSync("/etc/os-release").toString();
            const parsedFile = JSON.parse(os_release);

            if (parsedFile && parsedFile.fw_arm_ver) {
                firmwareVersion.valid = true;

                firmwareVersion.arm = parsedFile.fw_arm_ver.split("_")?.[1];
            }
        } catch (e) {
            Logger.warn("Unable to determine the Firmware Version", e);
        }

        return firmwareVersion;
    }

    getModelDetails() {
        return Object.assign(
            {},
            super.getModelDetails(),
            {
                supportedAttachments: [
                    stateAttrs.AttachmentStateAttribute.TYPE.WATERTANK,
                    stateAttrs.AttachmentStateAttribute.TYPE.MOP,
                ]
            }
        );
    }

    /**
     * @return {object}
     */
    getProperties() {
        const superProps = super.getProperties();
        const ourProps = {};

        if (this.config.get("embedded") === true) {
            const firmwareVersion = this.getFirmwareVersion();

            if (firmwareVersion.valid) {
                ourProps[DreameValetudoRobot.WELL_KNOWN_PROPERTIES.FIRMWARE_VERSION] = firmwareVersion.arm;
            }
        }

        return Object.assign(
            {},
            superProps,
            ourProps
        );
    }


    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        const deviceConf = MiioValetudoRobot.READ_DEVICE_CONF(DreameValetudoRobot.DEVICE_CONF_PATH);

        return !!(deviceConf && deviceConf.model === "dreame.vacuum.p2009");
    }
}

DreameValetudoRobot.DEVICE_CONF_PATH = "/data/config/miio/device.conf";
DreameValetudoRobot.TOKEN_FILE_PATH = "/data/config/miio/device.token";
DreameValetudoRobot.MULTI_MAP_CONFIG_PATH = "/data/config/ava/mult_map.json";
DreameValetudoRobot.MAP_BACKUP_INFO_PATH = "/data/config/ava/map_bak_info.json";
DreameValetudoRobot.MAP_INFO_PATH = "/data/log/map_info.bin";
DreameValetudoRobot.DIVIDE_MAP_PATH = "/data/DivideMap";

DreameValetudoRobot.PARSE_DREAME_MAP_ROTATION = (rotation) => {
    const parsedRotation = typeof rotation === "string" ? parseInt(rotation, 10) : rotation;

    return [0, 90, 180, 270].includes(parsedRotation) ? parsedRotation : undefined;
};

DreameValetudoRobot.ROTATE_POINT_AROUND_BOUNDS = (x, y, bounds, rotation) => {
    const centerX = (bounds.x.min + bounds.x.max) / 2;
    const centerY = (bounds.y.min + bounds.y.max) / 2;
    const dx = x - centerX;
    const dy = y - centerY;

    switch (rotation) {
        case 90:
            return [Math.round(centerX - dy), Math.round(centerY + dx)];
        case 180:
            return [Math.round(centerX - dx), Math.round(centerY - dy)];
        case 270:
            return [Math.round(centerX + dy), Math.round(centerY - dx)];
        default:
            return [x, y];
    }
};

DreameValetudoRobot.COORDINATE_TUPLE_ASC_SORT = (a, b) => {
    if (a[1] !== b[1]) {
        return a[1] - b[1];
    }

    return a[0] - b[0];
};

DreameValetudoRobot.GET_LAYER_PIXEL_BOUNDS = (layers) => {
    return layers.reduce((bounds, layer) => {
        return {
            x: {
                min: Math.min(bounds.x.min, layer.dimensions.x.min),
                max: Math.max(bounds.x.max, layer.dimensions.x.max)
            },
            y: {
                min: Math.min(bounds.y.min, layer.dimensions.y.min),
                max: Math.max(bounds.y.max, layer.dimensions.y.max)
            }
        };
    }, {
        x: {min: Infinity, max: -Infinity},
        y: {min: Infinity, max: -Infinity}
    });
};

DreameValetudoRobot.EXPAND_COMPRESSED_PIXELS = (compressedPixels) => {
    const pixels = [];

    for (let i = 0; i < compressedPixels.length; i += 3) {
        for (let offset = 0; offset < compressedPixels[i + 2]; offset++) {
            pixels.push([compressedPixels[i] + offset, compressedPixels[i + 1]]);
        }
    }

    return pixels;
};

DreameValetudoRobot.STATUS_MAP = Object.freeze({
    0: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    1: {
        value: stateAttrs.StatusStateAttribute.VALUE.PAUSED
    },
    2: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING
    },
    3: {
        value: stateAttrs.StatusStateAttribute.VALUE.RETURNING
    },
    4: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING,
        flag: stateAttrs.StatusStateAttribute.FLAG.SEGMENT
    },
    5: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING
    },
    6: {
        value: stateAttrs.StatusStateAttribute.VALUE.DOCKED
    },
    7: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    8: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    9: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    10: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    11: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    12: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    13: {
        value: stateAttrs.StatusStateAttribute.VALUE.MANUAL_CONTROL
    },
    14: { //Powersave
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    15: { //SelfTest/AutoRepair of the W10 dock?
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    16: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    17: {
        value: stateAttrs.StatusStateAttribute.VALUE.IDLE
    },
    18: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING,
        flag: stateAttrs.StatusStateAttribute.FLAG.SEGMENT
    },
    19: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING,
        flag: stateAttrs.StatusStateAttribute.FLAG.ZONE
    },
    20: {
        value: stateAttrs.StatusStateAttribute.VALUE.CLEANING,
        flag: stateAttrs.StatusStateAttribute.FLAG.SPOT
    },
    21: {
        value: stateAttrs.StatusStateAttribute.VALUE.MOVING,
        flag: stateAttrs.StatusStateAttribute.FLAG.MAPPING
    },
    // 22?
    23: {
        value: stateAttrs.StatusStateAttribute.VALUE.MOVING,
        flag: stateAttrs.StatusStateAttribute.FLAG.TARGET
    }
});

DreameValetudoRobot.FAN_SPEEDS = {
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW]: 0,
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM]: 1,
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH]: 2,
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX]: 3
};

DreameValetudoRobot.WATER_GRADES = Object.freeze({
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW]: 1,
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM]: 2,
    [stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH]: 3,
});

DreameValetudoRobot.AUTO_EMPTY_DOCK_STATUS_MAP = Object.freeze({
    0: stateAttrs.DockStatusStateAttribute.VALUE.IDLE,
    1: stateAttrs.DockStatusStateAttribute.VALUE.EMPTYING,
    2: stateAttrs.DockStatusStateAttribute.VALUE.IDLE, // DND
});

DreameValetudoRobot.MOP_DOCK_STATUS_MAP = Object.freeze({
    0: stateAttrs.DockStatusStateAttribute.VALUE.IDLE,
    1: stateAttrs.DockStatusStateAttribute.VALUE.CLEANING,
    2: stateAttrs.DockStatusStateAttribute.VALUE.DRYING,
    3: stateAttrs.DockStatusStateAttribute.VALUE.CLEANING, //TODO: idle instead?
    4: stateAttrs.DockStatusStateAttribute.VALUE.PAUSE,
    5: stateAttrs.DockStatusStateAttribute.VALUE.CLEANING,
    6: stateAttrs.DockStatusStateAttribute.VALUE.CLEANING,
});


/**
 *
 * @param {string} vendorErrorCode
 *
 * @returns {ValetudoRobotError}
 */
DreameValetudoRobot.MAP_ERROR_CODE = (vendorErrorCode) => {
    const parameters = {
        severity: {
            kind: ValetudoRobotError.SEVERITY_KIND.UNKNOWN,
            level: ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN,
        },
        subsystem: ValetudoRobotError.SUBSYSTEM.UNKNOWN,
        message: `Unknown error ${vendorErrorCode}`,
        vendorErrorCode: vendorErrorCode
    };

    switch (vendorErrorCode) {
        case "0":
            parameters.message = "No error";
            break;
        case "1":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = "Wheel lost floor contact";
            break;
        case "2":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Cliff sensor dirty or robot on the verge of falling";
            break;
        case "3":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Stuck front bumper";
            break;
        case "4":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Tilted robot";
            break;
        case "5":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Stuck front bumper";
            break;
        case "6":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = "Wheel lost floor contact";
            break;
        case "7":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "8":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Dustbin missing";
            break;
        case "9":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Water tank missing";
            break;
        case "10":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Water tank empty";
            break;
        case "11":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Dustbin full";
            break;
        case "12":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.MOTORS;
            parameters.message = "Main brush jammed";
            break;
        case "13":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.MOTORS;
            parameters.message = "Side brush jammed";
            break;
        case "14":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Filter jammed";
            break;
        case "15":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "16":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "17":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "18":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "19":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.POWER;
            parameters.message = "Charging station without power";
            break;
        case "20":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.INFO;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.POWER;
            parameters.message = "Low battery";
            break;
        case "21":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.POWER;
            parameters.message = "Charging error";
            break;
        //22
        case "23":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`; //"AVA_HEALTH_STATUS_TYPE_HEART" //TODO What does the dreame error string mean?
            break;
        case "24":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Camera dirty";
            break;
        case "25":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`; //"AVA_HEALTH_STATUS_TYPE_MOVE" //TODO What does the dreame error string mean?
            break;
        case "26":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Camera dirty";
            break;
        case "27":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Sensor dirty";
            break;
        case "28":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.POWER;
            parameters.message = "Charging station without power";
            break;
        case "29":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.POWER;
            parameters.message = "Battery temperature out of operating range";
            break;
        case "30":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.MOTORS;
            parameters.message = "Fan speed abnormal";
            break;
        case "31":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "32":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;
        case "33":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Accelerometer sensor error";
            break;
        case "34":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Gyroscope sensor error";
            break;
        case "35":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Gyroscope sensor error";
            break;
        case "36":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Left magnetic field sensor error";
            break;
        case "37":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Right magnetic field sensor error";
            break;
        case "38":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`; //"AVA_HEALTH_STATUS_TYPE_I_FLOW_ERROR" //TODO What does the dreame error string mean?
            break;
        case "39":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`; //"AVA_HEALTH_STATUS_TYPE_INFRARED_FAULT" //TODO What does the dreame error string mean?
            break;
        case "40":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Camera fault";
            break;
        case "41":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.INFO;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Magnetic interference";
            break;
        case "42":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Water pump fault";
            break;
        case "43":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = "RTC fault";
            break;
        case "44":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`; //"AVA_HEALTH_STATUS_TYPE_I_AUTO_KEY_TRIG" //TODO What does the dreame error string mean?
            break;
        case "45":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = "3.3V rail abnormal";
            break;
        case "46":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "47":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "48":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "LDS jammed";
            break;
        case "49":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "LDS bumper jammed";
            break;
        case "50":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "51":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Filter jammed";
            break;
        case "52":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "53":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "ToF Sensor offline";
            break;
        case "54":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.SENSORS;
            parameters.message = "Wall sensor dirty";
            break;
        case "55":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = "Attempted to start mopping while on carpet";
            break;
        case "56":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "57":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "58":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "59":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot trapped by virtual restrictions";
            break;
        case "60":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.UNKNOWN;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.UNKNOWN;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.CORE;
            parameters.message = `Internal error ${vendorErrorCode}`;
            break;
        case "61":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "62":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "63":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "64":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "65":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "66":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "67":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        // 68: Not an Error. "Docked but mop is still attached. Please remove the mop"
        case "69":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Lost mop pad";
            break;
        case "70":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Lost mop pad";
            break;

        case "71":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.MOTORS;
            parameters.message = "Mop motor fault";
            break;
        case "72":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.MOTORS;
            parameters.message = "Mop motor current abnormal";
            break;

        case "74":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.ATTACHMENTS;
            parameters.message = "Failed to attach mop pads";
            break;

        case "82":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;

        case "91":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;
        case "96":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot reach target";
            break;

        case "98":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Robot stuck or trapped";
            break;


        case "-2":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Stuck inside restricted area";
            break;


        case "101":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Auto-Empty Dock dust bag full or dust duct clogged";
            break;
        case "102":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Auto-Empty Dock cover open or missing dust bag";
            break;
        case "103":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Auto-Empty Dock cover open or missing dust bag";
            break;
        case "104":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Auto-Empty Dock dust bag full or dust duct clogged";
            break;



        case "105":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Clean Water Tank not installed";
            break;
        case "106":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Wastewater Tank not installed or full";
            break;
        case "107":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Clean Water Tank empty";
            break;
        case "108":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Wastewater Tank not installed or full";
            break;
        case "109":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Wastewater pipe clogged";
            break;
        case "110":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.CATASTROPHIC;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Wastewater pump damaged";
            break;
        case "111":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Tray not installed";
            break;
        case "112":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Tray full of water";
            break;
        // 114: Not an Error. "Please remember to clean the mop tray"
        case "116":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Clean Water Tank empty";
            break;
        case "117":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.TRANSIENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.NAVIGATION;
            parameters.message = "Cannot navigate to the dock";
            break;
        case "118":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Wastewater Tank not installed or full";
            break;
        case "119":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop Dock Tray full of water";
            break;
        case "120":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.ERROR;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Mop pads not in the dock. Attach failed.";
            break;
        case "121":
            parameters.severity.kind = ValetudoRobotError.SEVERITY_KIND.PERMANENT;
            parameters.severity.level = ValetudoRobotError.SEVERITY_LEVEL.WARNING;
            parameters.subsystem = ValetudoRobotError.SUBSYSTEM.DOCK;
            parameters.message = "Auto-Empty Dock dust bag full or dust duct clogged";
            break;
    }

    return new ValetudoRobotError(parameters);
};

module.exports = DreameValetudoRobot;
