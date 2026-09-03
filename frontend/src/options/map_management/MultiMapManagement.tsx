import React from "react";
import {Link as RouterLink} from "react-router-dom";
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Menu,
    MenuItem,
    TextField,
    Typography,
    useTheme
} from "@mui/material";
import PaperContainer from "../../components/PaperContainer";
import ConfirmationDialog from "../../components/ConfirmationDialog";
import {
    MultiMapEntry,
    RawMapData,
    useDeleteMapMutation,
    useMultiMapPreviewQuery,
    useMultiMapQuery,
    useRenameMapMutation,
    useRobotStatusQuery,
    useRotateMapMutation,
    useSelectMapMutation
} from "../../api";
import {MapLayerManager} from "../../map/MapLayerManager";
import {MoreVert as MoreVertIcon} from "@mui/icons-material";

const MAP_ROTATIONS = [0, 90, 180, 270];

const SavedMapPreview = ({mapId}: {mapId: string}): React.ReactElement => {
    const theme = useTheme();
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const mapLayerManager = React.useMemo(() => new MapLayerManager(), []);
    const {data: preview, isPending, isError} = useMultiMapPreviewQuery(mapId);

    React.useEffect(() => {
        return () => mapLayerManager.dispose();
    }, [mapLayerManager]);

    React.useEffect(() => {
        let cancelled = false;
        const canvas = canvasRef.current;

        if (!canvas || !preview) {
            return;
        }

        const render = async (map: RawMapData) => {
            const ctx = canvas.getContext("2d");

            if (!ctx) {
                return;
            }

            await mapLayerManager.draw(map, theme.palette.mode);

            if (cancelled) {
                return;
            }

            const source = mapLayerManager.getCanvas();
            const bounds = getMapLayerBounds(map);

            canvas.width = canvas.clientWidth * window.devicePixelRatio;
            canvas.height = canvas.clientHeight * window.devicePixelRatio;

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = false;

            if (!bounds) {
                return;
            }

            const padding = 16 * window.devicePixelRatio;
            const width = Math.max(bounds.maxX - bounds.minX + 1, 1);
            const height = Math.max(bounds.maxY - bounds.minY + 1, 1);
            const scale = Math.min(
                (canvas.width - padding * 2) / width,
                (canvas.height - padding * 2) / height
            );
            const targetWidth = width * scale;
            const targetHeight = height * scale;
            const targetX = (canvas.width - targetWidth) / 2;
            const targetY = (canvas.height - targetHeight) / 2;

            ctx.drawImage(
                source,
                bounds.minX,
                bounds.minY,
                width,
                height,
                targetX,
                targetY,
                targetWidth,
                targetHeight
            );
        };

        render(preview).catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [mapLayerManager, preview, theme.palette.mode]);

    if (isPending) {
        return (
            <Box sx={{display: "flex", alignItems: "center", justifyContent: "center", height: "100%"}}>
                <CircularProgress size={24}/>
            </Box>
        );
    }

    if (isError || !preview) {
        return (
            <Box sx={{display: "flex", alignItems: "center", justifyContent: "center", height: "100%", px: 2, textAlign: "center"}}>
                <Typography variant="body2" color="textSecondary">Preview unavailable</Typography>
            </Box>
        );
    }

    return <canvas ref={canvasRef} style={{width: "100%", height: "100%", display: "block"}}/>;
};

const getMapLayerBounds = (map: RawMapData): {minX: number, minY: number, maxX: number, maxY: number} | undefined => {
    if (map.layers.length === 0) {
        return undefined;
    }

    return map.layers.reduce((bounds, layer) => {
        return {
            minX: Math.min(bounds.minX, layer.dimensions.x.min),
            minY: Math.min(bounds.minY, layer.dimensions.y.min),
            maxX: Math.max(bounds.maxX, layer.dimensions.x.max),
            maxY: Math.max(bounds.maxY, layer.dimensions.y.max)
        };
    }, {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    });
};

const SavedMapCard = ({
    map,
    disabled,
    mutationPending,
    onSelect,
    onRename,
    onDelete,
    onRotate
}: {
    map: MultiMapEntry,
    disabled: boolean,
    mutationPending: boolean,
    onSelect: (mapId: string) => void,
    onRename: (map: MultiMapEntry) => void,
    onDelete: (map: MultiMapEntry) => void,
    onRotate: (mapId: string, rotation: number) => void,
}): React.ReactElement => {
    const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
    const label = map.name?.trim() || `Map ${map.id}`;
    const mapLoading = map.selected && !map.current;
    const rotation = MAP_ROTATIONS.includes(map.rotation ?? 0) ? map.rotation ?? 0 : 0;

    return (
        <Box
            component="article"
            aria-label={label}
            sx={theme => ({
                position: "relative",
                flex: "0 0 min(78vw, 22rem)",
                scrollSnapAlign: "center",
                border: "1px solid",
                borderColor: map.selected ? theme.palette.primary.main : "divider",
                borderRadius: 2,
                bgcolor: "background.paper",
                overflow: "hidden",
                boxShadow: map.selected ? theme.shadows[6] : theme.shadows[1],
                transition: "border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease",
                transform: map.selected ? "translateY(-2px)" : "none"
            })}
        >
            <Box sx={{height: "16rem", bgcolor: "background.default", borderBottom: "1px solid", borderColor: "divider"}}>
                <SavedMapPreview mapId={map.id}/>
            </Box>
            <Box sx={{p: 2, display: "flex", gap: 1, alignItems: "center"}}>
                <Box sx={{minWidth: 0, flex: 1}}>
                    <Typography variant="h6" noWrap>{label}</Typography>
                    <Typography variant="body2" color="textSecondary">
                        {mapLoading ? "Loading map" : map.current ? "Current map" : `Map ${map.id}`}
                    </Typography>
                </Box>
                {mapLoading && <CircularProgress size={18}/>}
                <IconButton
                    aria-label={`Actions for ${label}`}
                    onClick={event => {
                        event.stopPropagation();
                        setMenuAnchor(event.currentTarget);
                    }}
                >
                    <MoreVertIcon/>
                </IconButton>
            </Box>
            {map.selected && (
                <Box sx={theme => ({position: "absolute", inset: 0, border: `2px solid ${theme.palette.primary.main}`, borderRadius: 2, pointerEvents: "none"})}/>
            )}
            <Menu
                anchorEl={menuAnchor}
                open={menuAnchor !== null}
                onClose={() => setMenuAnchor(null)}
                onClick={event => event.stopPropagation()}
            >
                <MenuItem disabled={disabled || mutationPending || map.selected} onClick={() => {
                    setMenuAnchor(null);
                    onSelect(map.id);
                }}>
                    {map.selected ? "Selected" : "Select"}
                </MenuItem>
                <MenuItem
                    component={RouterLink}
                    to={`/options/map_management/saved_maps/${map.id}/edit`}
                    disabled={!map.current}
                    onClick={() => setMenuAnchor(null)}
                >
                    Edit
                </MenuItem>
                <MenuItem disabled={disabled || mutationPending} onClick={() => {
                    setMenuAnchor(null);
                    onRename(map);
                }}>
                    Rename
                </MenuItem>
                <MenuItem disableRipple disabled={disabled || mutationPending}>
                    <TextField
                        select
                        size="small"
                        label="Rotate"
                        value={rotation}
                        SelectProps={{native: true}}
                        disabled={disabled || mutationPending}
                        onClick={event => event.stopPropagation()}
                        onChange={event => {
                            setMenuAnchor(null);
                            onRotate(map.id, Number(event.target.value));
                        }}
                        sx={{minWidth: "7rem"}}
                    >
                        {MAP_ROTATIONS.map(option => (
                            <option key={option} value={option}>{option}°</option>
                        ))}
                    </TextField>
                </MenuItem>
                <MenuItem disabled={disabled || mutationPending || map.selected || map.current} sx={{color: "error.main"}} onClick={() => {
                    setMenuAnchor(null);
                    onDelete(map);
                }}>
                    Delete
                </MenuItem>
            </Menu>
        </Box>
    );
};

const MultiMapManagement = (): React.ReactElement => {
    const {
        data: multiMapState,
        isPending: multiMapStatePending,
        isError: multiMapStateError,
        refetch: refetchMultiMapState
    } = useMultiMapQuery();
    const {data: robotStatus} = useRobotStatusQuery();
    const {mutate: selectMap, isPending: selectMapPending} = useSelectMapMutation();
    const {mutate: renameMap, isPending: renameMapPending} = useRenameMapMutation();
    const {mutate: deleteMap, isPending: deleteMapPending} = useDeleteMapMutation();
    const {mutate: rotateMap, isPending: rotateMapPending} = useRotateMapMutation();
    const [mapToRename, setMapToRename] = React.useState<MultiMapEntry>();
    const [mapToDelete, setMapToDelete] = React.useState<MultiMapEntry>();
    const [newMapName, setNewMapName] = React.useState("");
    const selectedMapLoading = multiMapState?.maps.some(map => {
        return map.selected && !map.current;
    }) === true;
    const mapManagementDisabled = robotStatus?.value !== "docked" && robotStatus?.value !== "idle";
    const mapMutationPending = selectMapPending || renameMapPending || deleteMapPending || rotateMapPending;

    React.useEffect(() => {
        if (!selectedMapLoading) {
            return;
        }

        const interval = setInterval(() => {
            refetchMultiMapState().catch(() => undefined);
        }, 1000);

        return () => clearInterval(interval);
    }, [refetchMultiMapState, selectedMapLoading]);

    if (multiMapStatePending) {
        return (
            <PaperContainer>
                <CircularProgress />
            </PaperContainer>
        );
    }

    if (multiMapStateError || !multiMapState) {
        return (
            <PaperContainer>
                <Typography color="error">Could not load saved maps.</Typography>
            </PaperContainer>
        );
    }

    return (
        <PaperContainer>
            <Typography variant="h5" gutterBottom>
                Saved Maps
            </Typography>
            <Typography color="textSecondary" paragraph>
                Select which firmware-managed map Valetudo should target for map edits.
            </Typography>
            {
                mapManagementDisabled &&
                <Typography color="textSecondary" paragraph>
                    Map editing is disabled while the robot is running.
                </Typography>
            }
            <Box
                sx={{
                    display: "flex",
                    gap: 2,
                    overflowX: "auto",
                    scrollSnapType: "x mandatory",
                    px: {xs: 1, sm: 2},
                    py: 2,
                    mx: {xs: -1, sm: -2}
                }}
            >
                {multiMapState.maps.map(map => (
                    <SavedMapCard
                        key={map.id}
                        map={map}
                        disabled={mapManagementDisabled}
                        mutationPending={mapMutationPending}
                        onSelect={selectMap}
                        onRename={mapToRename => {
                            setMapToRename(mapToRename);
                            setNewMapName(mapToRename.name?.trim() || "");
                        }}
                        onDelete={setMapToDelete}
                        onRotate={(mapId, rotation) => rotateMap({mapId: mapId, rotation: rotation})}
                    />
                ))}
            </Box>
            <Dialog
                open={mapToRename !== undefined}
                onClose={() => setMapToRename(undefined)}
            >
                <DialogTitle>Rename map</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        margin="dense"
                        label="Map name"
                        value={newMapName}
                        onChange={event => setNewMapName(event.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setMapToRename(undefined)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => {
                            if (mapToRename) {
                                renameMap({mapId: mapToRename.id, name: newMapName});
                                setMapToRename(undefined);
                            }
                        }}
                    >
                        Save
                    </Button>
                </DialogActions>
            </Dialog>
            <ConfirmationDialog
                title={mapToDelete ? `Delete ${mapToDelete.name?.trim() || `Map ${mapToDelete.id}`}?` : "Delete map?"}
                text="This permanently deletes the saved robot map from firmware storage."
                open={mapToDelete !== undefined}
                onClose={() => setMapToDelete(undefined)}
                onAccept={() => {
                    if (mapToDelete) {
                        deleteMap(mapToDelete.id);
                    }
                }}
            />
        </PaperContainer>
    );
};

export default MultiMapManagement;
