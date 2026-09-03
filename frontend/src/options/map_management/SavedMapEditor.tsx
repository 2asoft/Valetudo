import React from "react";
import {useParams} from "react-router";
import {
    Box,
    CircularProgress,
    Divider,
    IconButton,
    List,
    ListItem,
    Paper,
    Slider,
    Typography,
    useTheme
} from "@mui/material";
import {
    ExpandLess,
    ExpandMore,
    Repeat,
    Visibility,
    VisibilityOff
} from "@mui/icons-material";
import PaperContainer from "../../components/PaperContainer";
import {
    Capability,
    useMultiMapQuery,
    SegmentPreferencesEntry,
    useRobotMapQuery,
    useRobotStatusQuery,
    useSegmentOrderMutation,
    useSegmentPreferenceMutation,
    useSegmentPreferencesQuery,
    useSegmentVisibilityMutation
} from "../../api";
import EditMap from "../../map/EditMap";
import {getPresetIconOrLabel, presetFriendlyNames} from "../../presetUtils";
import {useCapabilitiesSupported} from "../../CapabilitiesProvider";
import {useSnackbar} from "notistack";

const SavedMapEditor = (): React.ReactElement => {
    const {mapId} = useParams();
    const theme = useTheme();
    const {enqueueSnackbar} = useSnackbar();
    const {data: multiMapState, isPending: mapsPending, isError: mapsError} = useMultiMapQuery();
    const {data: currentMapData, isPending: currentMapPending, isError: currentMapError} = useRobotMapQuery();
    const {data: robotStatus, isPending: robotStatusPending} = useRobotStatusQuery();
    const map = multiMapState?.maps.find(candidate => candidate.id === mapId);
    const editable = map?.current === true;
    const [
        combinedVirtualRestrictionsCapabilitySupported,
        mapSegmentEditCapabilitySupported,
        mapSegmentRenameCapabilitySupported,
        mapSegmentMaterialControlCapabilitySupported,
        segmentPreferencesCapabilitySupported
    ] = useCapabilitiesSupported(
        Capability.CombinedVirtualRestrictions,
        Capability.MapSegmentEdit,
        Capability.MapSegmentRename,
        Capability.MapSegmentMaterialControl,
        Capability.SegmentPreferences
    );
    const {
        data: segmentPreferences,
        isPending: segmentPreferencesPending,
        isError: segmentPreferencesError
    } = useSegmentPreferencesQuery(mapId, editable && segmentPreferencesCapabilitySupported);
    const {mutateAsync: setOrder, isPending: orderSaving} = useSegmentOrderMutation(mapId);
    const {mutate: setVisibility, isPending: visibilitySaving} = useSegmentVisibilityMutation(mapId);
    const [segments, setSegments] = React.useState<Array<SegmentPreferencesEntry>>([]);
    const [orderModified, setOrderModified] = React.useState(false);
    const orderSaveInFlight = React.useRef(false);
    React.useEffect(() => {
        if (segmentPreferences?.segments && !orderModified && !orderSaving) {
            setSegments(segmentPreferences.segments);
        }
    }, [orderModified, orderSaving, segmentPreferences]);

    const offsetSegment = (index: number, offset: number) => {
        const newSegments = segments.slice();
        const movedSegment = newSegments.splice(index, 1)[0];

        newSegments.splice(index + offset, 0, movedSegment);
        setSegments(newSegments);
        setOrderModified(true);
    };

    const updateSegmentPreference = React.useCallback((segmentId: string, key: keyof NonNullable<SegmentPreferencesEntry["preferences"]>, value: number) => {
        setSegments(currentSegments => currentSegments.map(segment => {
            if (segment.id !== segmentId || segment.preferences === undefined) {
                return segment;
            }

            return {
                ...segment,
                preferences: {
                    ...segment.preferences,
                    [key]: value
                }
            };
        }));
    }, []);

    React.useEffect(() => {
        if (!orderModified || orderSaving || orderSaveInFlight.current) {
            return;
        }

        const segmentOrder = segments.map(segment => segment.id);
        const timer = window.setTimeout(() => {
            orderSaveInFlight.current = true;
            setOrder(segmentOrder).then(() => {
                setOrderModified(false);
            }).catch(() => {
                if (segmentPreferences?.segments) {
                    setSegments(segmentPreferences.segments);
                }
                setOrderModified(false);
            }).finally(() => {
                orderSaveInFlight.current = false;
            });
        }, 750);

        return () => window.clearTimeout(timer);
    }, [orderModified, orderSaving, segmentPreferences, segments, setOrder]);

    if (mapsPending || robotStatusPending || currentMapPending) {
        return <PaperContainer><CircularProgress/></PaperContainer>;
    }

    if (mapsError || !multiMapState) {
        return <PaperContainer><Typography color="error">Could not load saved maps.</Typography></PaperContainer>;
    }

    if (!map) {
        return <PaperContainer><Typography color="error">Saved map not found.</Typography></PaperContainer>;
    }

    if (!robotStatus) {
        return <PaperContainer><Typography color="error">Could not load robot status.</Typography></PaperContainer>;
    }

    if (!editable) {
        return (
            <PaperContainer>
                <Typography variant="h6" gutterBottom>{map.name ?? `Map ${map.id}`}</Typography>
                <Typography color="textSecondary">
                    This saved map is not currently loaded by the robot. Editing is disabled because Valetudo only edits full maps received from firmware, not saved-map thumbnails.
                </Typography>
            </PaperContainer>
        );
    }

    if (currentMapError || !currentMapData) {
        return <PaperContainer><Typography color="error">Could not load the current editable map.</Typography></PaperContainer>;
    }

    return (
        <Box sx={{height: "calc(100vh - 4rem)", display: "flex", flexDirection: {xs: "column", md: "row"}, overflow: "hidden"}}>
            <Box sx={{flex: 1, minWidth: 0, minHeight: 0, position: "relative"}}>
                <EditMap
                    rawMap={currentMapData}
                    paletteMode={theme.palette.mode}
                    mode="combined"
                    helpText="Saved map edit mode: segment editing, virtual restrictions, and room preferences should all operate on this saved map."
                    robotStatus={robotStatus}
                    enqueueSnackbar={enqueueSnackbar}
                    supportedCapabilities={{
                        [Capability.CombinedVirtualRestrictions]: combinedVirtualRestrictionsCapabilitySupported,
                        [Capability.MapSegmentEdit]: mapSegmentEditCapabilitySupported,
                        [Capability.MapSegmentRename]: mapSegmentRenameCapabilitySupported,
                        [Capability.MapSegmentMaterialControl]: mapSegmentMaterialControlCapabilitySupported,
                        [Capability.MapAnnotations]: false
                    }}
                    targetMapId={mapId}
                />
            </Box>

            {segmentPreferencesCapabilitySupported && (
                <Paper
                    elevation={0}
                    square
                    sx={{
                        width: {xs: "100%", md: 380},
                        height: {xs: "45%", md: "auto"},
                        flex: "0 0 auto",
                        borderTop: {xs: "1px solid", md: 0},
                        borderLeft: {xs: 0, md: "1px solid"},
                        borderColor: "divider",
                        p: 2,
                        overflow: "auto"
                    }}
                >
                    <Typography variant="h6" gutterBottom>Rooms</Typography>
                    <Typography color="textSecondary" paragraph>
                        Use this panel for room order, visibility, and per-room cleaning preferences while segment and restriction tools stay directly on the map.
                    </Typography>
                    {segmentPreferencesError ? (
                        <Typography color="error">Could not load room preferences.</Typography>
                    ) : segmentPreferencesPending ? <CircularProgress size={24}/> : (
                        <>
                            <List dense disablePadding>
                                {segments.map((segment, index) => {
                                    const hidden = segment.visibility === "hidden";

                                    return (
                                        <React.Fragment key={segment.id}>
                                            {index > 0 && <Divider component="li"/>}
                                            <ListItem sx={{display: "block", px: 0}}>
                                                <Box sx={{display: "flex", alignItems: "center", gap: 1, mb: 1}}>
                                                    <Typography variant="subtitle2" sx={{flex: 1}}>
                                                        {index + 1}. {segment.name ?? `Segment ${segment.id}`}
                                                    </Typography>
                                                    <IconButton size="small" disabled={index === 0 || orderSaving} onClick={() => offsetSegment(index, -1)}>
                                                        <ExpandLess/>
                                                    </IconButton>
                                                    <IconButton size="small" disabled={index === segments.length - 1 || orderSaving} onClick={() => offsetSegment(index, 1)}>
                                                        <ExpandMore/>
                                                    </IconButton>
                                                    {segment.visibility !== undefined && (
                                                        <IconButton
                                                            size="small"
                                                            disabled={visibilitySaving}
                                                            onClick={() => setVisibility({
                                                                segmentId: segment.id,
                                                                visibility: hidden ? "visible" : "hidden"
                                                            })}
                                                        >
                                                            {hidden ? <VisibilityOff/> : <Visibility/>}
                                                        </IconButton>
                                                    )}
                                                </Box>
                                                <RoomPreferenceControls
                                                    segment={segment}
                                                    disabled={!["idle", "docked"].includes(robotStatus.value) || orderSaving || visibilitySaving}
                                                    mapId={mapId}
                                                    onPreferenceChange={updateSegmentPreference}
                                                />
                                            </ListItem>
                                        </React.Fragment>
                                    );
                                })}
                            </List>
                            {orderSaving && <Typography variant="body2" color="textSecondary" sx={{mt: 1}}>Saving room order...</Typography>}
                        </>
                    )}
                </Paper>
            )}
        </Box>
    );
};

const ROOM_PRESET_CONTROLS: Array<RoomPresetControlDefinition> = [
    {
        key: "suctionLevel",
        label: "Fan Speed",
        values: [0, 1, 2, 3, 4],
        valueLabels: {
            0: presetFriendlyNames.off,
            1: presetFriendlyNames.min,
            2: presetFriendlyNames.medium,
            3: presetFriendlyNames.high,
            4: presetFriendlyNames.max
        },
        mark: value => getPresetIconOrLabel(Capability.FanSpeedControl, SUCTION_PRESETS[value], {height: "18px", width: "auto"})
    },
    {
        key: "waterVolume",
        label: "Water",
        values: [1, 2, 3, 5, 10],
        valueLabels: {
            1: presetFriendlyNames.min,
            2: presetFriendlyNames.low,
            3: presetFriendlyNames.medium,
            5: presetFriendlyNames.high,
            10: presetFriendlyNames.max
        },
        mark: value => getPresetIconOrLabel(Capability.WaterUsageControl, WATER_PRESETS[value], {height: "18px", width: "auto"})
    },
    {
        key: "cleaningTimes",
        label: "Passes",
        values: [1, 2, 3],
        valueLabels: {
            1: "1×",
            2: "2×",
            3: "3×"
        },
        mark: value => <Box sx={{display: "flex", alignItems: "center", gap: 0.25}}><Repeat fontSize="small"/>{value}×</Box>
    }
];

const SUCTION_PRESETS: Record<number, "off" | "min" | "medium" | "high" | "max"> = {
    0: "off",
    1: "min",
    2: "medium",
    3: "high",
    4: "max"
};

const WATER_PRESETS: Record<number, "min" | "low" | "medium" | "high" | "max"> = {
    1: "min",
    2: "low",
    3: "medium",
    5: "high",
    10: "max"
};

interface RoomPresetControlDefinition {
    key: keyof NonNullable<SegmentPreferencesEntry["preferences"]>,
    label: string,
    values: Array<number>,
    valueLabels: Record<number, string>,
    mark: (value: number) => React.ReactNode
}

const RoomPreferenceControls = ({segment, disabled, mapId, onPreferenceChange}: {
    segment: SegmentPreferencesEntry,
    disabled: boolean,
    mapId?: string,
    onPreferenceChange(segmentId: string, key: keyof NonNullable<SegmentPreferencesEntry["preferences"]>, value: number): void
}): React.ReactElement => {
    return (
        <Box sx={{display: "grid", gap: 1}}>
            {ROOM_PRESET_CONTROLS.map(control => (
                <RoomPresetControl
                    key={control.key}
                    control={control}
                    segment={segment}
                    disabled={disabled}
                    mapId={mapId}
                    onPreferenceChange={onPreferenceChange}
                />
            ))}
        </Box>
    );
};

const RoomPresetControl = ({control, segment, disabled, mapId, onPreferenceChange}: {
    control: RoomPresetControlDefinition,
    segment: SegmentPreferencesEntry,
    disabled: boolean,
    mapId?: string,
    onPreferenceChange(segmentId: string, key: keyof NonNullable<SegmentPreferencesEntry["preferences"]>, value: number): void
}): React.ReactElement | null => {
    const {mutateAsync: setPreference, isPending} = useSegmentPreferenceMutation(mapId);
    const value = segment.preferences?.[control.key];

    if (value === undefined) {
        return null;
    }

    const values = control.values.includes(value) ? control.values : [value, ...control.values].sort((a, b) => a - b);
    const sliderValue = values.indexOf(value);

    return (
        <Paper variant="outlined" sx={{px: 1.25, pt: 1, pb: 0.5}}>
            <Box sx={{display: "flex", alignItems: "center", gap: 1}}>
                <Typography variant="subtitle2" sx={{flex: 1}}>{control.label}</Typography>
                <Typography variant="body2" color="textSecondary">
                    {control.valueLabels[value] ?? value}
                </Typography>
            </Box>
            <Box sx={{px: 1.5}}>
                <Slider
                    size="small"
                    step={null}
                    value={sliderValue}
                    min={0}
                    max={values.length - 1}
                    disabled={disabled || isPending}
                    valueLabelDisplay="off"
                    marks={values.map((option, index) => ({
                        value: index,
                        label: control.mark(option)
                    }))}
                    onChangeCommitted={(_, newValue) => {
                        const index = Array.isArray(newValue) ? newValue[0] : newValue;
                        const nextValue = values[index];

                        if (nextValue !== value) {
                            onPreferenceChange(segment.id, control.key, nextValue);
                            setPreference({
                                segmentId: segment.id,
                                key: control.key,
                                value: nextValue
                            }).catch(() => {
                                onPreferenceChange(segment.id, control.key, value);
                            });
                        }
                    }}
                    sx={{mb: 2.5}}
                />
            </Box>
        </Paper>
    );
};

export default SavedMapEditor;
