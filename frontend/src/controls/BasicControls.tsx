import {
    Box,
    Button,
    ButtonGroup,
    DialogContentText,
    Grid2,
    Menu,
    MenuItem,
    Paper,
    Skeleton,
    Typography,
} from "@mui/material";
import {
    BasicControlCommand,
    Capability,
    StatusState,
    useBasicControlMutation,
    useRobotStatusQuery,
    useSegmentPreferencesApplyControlMutation,
    useSegmentPreferencesApplyControlQuery,
} from "../api";
import {
    ArrowDropDown as ArrowDropDownIcon,
    Home as HomeIcon,
    Pause as PauseIcon,
    PlayArrow as StartIcon,
    Stop as StopIcon,
    SvgIconComponent,
} from "@mui/icons-material";
import React from "react";
import {useSnackbar} from "notistack";
import ConfirmationDialog from "../components/ConfirmationDialog";
import {usePendingMapAction} from "../map/BaseMap";
import {useCapabilitiesSupported} from "../CapabilitiesProvider";

const StartStates: StatusState["value"][] = ["idle", "docked", "paused", "error"];
const PauseStates: StatusState["value"][] = ["cleaning", "returning", "moving"];

interface CommandButton {
    command: BasicControlCommand;
    enabled: boolean;
    label: string;
    Icon: SvgIconComponent;
}

type FullCleanupMode = "segment_preferences" | "common";

const BasicControls = (): React.ReactElement => {
    const [startConfirmationDialogOpen, setStartConfirmationDialogOpen] = React.useState(false);
    const [fullCleanupModeMenuAnchorEl, setFullCleanupModeMenuAnchorEl] = React.useState<HTMLButtonElement | null>(null);
    const [selectedFullCleanupMode, setSelectedFullCleanupMode] = React.useState<FullCleanupMode>("segment_preferences");
    const [fullCleanupModeSelectionDirty, setFullCleanupModeSelectionDirty] = React.useState(false);
    const {enqueueSnackbar} = useSnackbar();
    const [segmentPreferencesApplyControlSupported] = useCapabilitiesSupported(Capability.SegmentPreferencesApplyControl);
    const { data: status, isPending: statusPending } = useRobotStatusQuery();
    const {
        mutate: executeBasicControlCommand,
        mutateAsync: executeBasicControlCommandAsync,
        isPending: basicControlIsExecuting
    } = useBasicControlMutation();
    const {
        data: segmentPreferencesApplyControlState,
        isPending: segmentPreferencesApplyControlLoading,
        isError: segmentPreferencesApplyControlError,
        refetch: refetchSegmentPreferencesApplyControl,
    } = useSegmentPreferencesApplyControlQuery(segmentPreferencesApplyControlSupported);
    const {
        mutateAsync: setSegmentPreferencesApplyControlEnabled,
        isPending: segmentPreferencesApplyControlChanging,
    } = useSegmentPreferencesApplyControlMutation();

    const {
        hasPendingMapAction: hasPendingMapAction
    } = usePendingMapAction();

    React.useEffect(() => {
        if (segmentPreferencesApplyControlState !== undefined && !fullCleanupModeSelectionDirty) {
            setSelectedFullCleanupMode(segmentPreferencesApplyControlState.enabled ? "segment_preferences" : "common");
        }
    }, [fullCleanupModeSelectionDirty, segmentPreferencesApplyControlState]);

    const isPending = basicControlIsExecuting || segmentPreferencesApplyControlChanging;
    const fullCleanupModeUnavailable = segmentPreferencesApplyControlSupported && (
        segmentPreferencesApplyControlLoading || segmentPreferencesApplyControlError ||
        segmentPreferencesApplyControlState === undefined
    );

    const startFullCleanup = async () => {
        if (segmentPreferencesApplyControlSupported) {
            const requestedMode = fullCleanupModeSelectionDirty ? selectedFullCleanupMode : undefined;
            const refreshedState = await refetchSegmentPreferencesApplyControl();

            if (refreshedState.isError || refreshedState.data === undefined) {
                enqueueSnackbar("Could not load the full cleanup mode.", {variant: "error"});
                return;
            }

            const segmentPreferencesShouldApply = requestedMode !== undefined ?
                requestedMode === "segment_preferences" : refreshedState.data.enabled;
            let appliedState = refreshedState.data;

            if (appliedState.enabled !== segmentPreferencesShouldApply) {
                appliedState = await setSegmentPreferencesApplyControlEnabled(segmentPreferencesShouldApply);
            }

            if (appliedState?.enabled !== segmentPreferencesShouldApply) {
                enqueueSnackbar("Unable to set full cleanup mode.", {variant: "error"});
                return;
            }

            setSelectedFullCleanupMode(appliedState.enabled ? "segment_preferences" : "common");
            setFullCleanupModeSelectionDirty(false);
        }

        await executeBasicControlCommandAsync("start");
    };

    const sendCommand = (command: BasicControlCommand) => {
        if (command === "start" && status?.flag === "resumable") {
            executeBasicControlCommand(command);
        } else if (command === "start" && hasPendingMapAction) {
            setStartConfirmationDialogOpen(true);
        } else if (command === "start") {
            startFullCleanup().catch(() => undefined);
        } else {
            executeBasicControlCommand(command);
        }
    };

    if (statusPending) {
        return (
            <Grid2>
                <Paper>
                    <Box p={1}>
                        <Skeleton height="4rem" />
                    </Box>
                </Paper>
            </Grid2>
        );
    }

    if (status === undefined) {
        return (
            <Grid2>
                <Paper>
                    <Box p={1}>
                        <Typography color="error">Error loading basic controls</Typography>
                    </Box>
                </Paper>
            </Grid2>
        );
    }

    const { flag, value: state } = status;

    const startButton: CommandButton = {
        command: "start",
        enabled: StartStates.includes(state),
        label: flag === "resumable" ? "Resume" : "Start",
        Icon: StartIcon,
    };
    const fullCleanupModeMenuOpen = fullCleanupModeMenuAnchorEl !== null;
    const selectedFullCleanupModeLabel = selectedFullCleanupMode === "segment_preferences" ?
        "Room-specific settings" : "Common settings";

    const buttons: CommandButton[] = [
        {
            command: "pause",
            enabled: PauseStates.includes(state),
            Icon: PauseIcon,
            label: "Pause",
        },
        {
            command: "stop",
            enabled: flag === "resumable" || (state !== "idle" && state !== "docked"),
            Icon: StopIcon,
            label: "Stop",
        },
        {
            command: "home",
            enabled: state === "idle" || state === "error" || state === "paused",
            Icon: HomeIcon,
            label: "Dock",
        },
    ];

    return (
        <>
            <Grid2>
                <Paper>
                    <Box p={1.5}>
                        <Grid2 container direction="column" spacing={1}>
                            <Grid2>
                                <ButtonGroup
                                    fullWidth
                                    variant="outlined"
                                >
                                    <Button
                                        variant="outlined"
                                        size="medium"
                                        disabled={!startButton.enabled || isPending}
                                        onClick={() => {
                                            sendCommand(startButton.command);
                                        }}
                                        color="inherit"
                                        style={{height: "3.5em", borderColor: "inherit"}}
                                        aria-label={segmentPreferencesApplyControlSupported ?
                                            `${startButton.label}: ${selectedFullCleanupModeLabel}` : startButton.label
                                        }
                                    >
                                        <startButton.Icon />
                                    </Button>
                                    {segmentPreferencesApplyControlSupported && (
                                        <Button
                                            variant="outlined"
                                            size="medium"
                                            disabled={isPending || fullCleanupModeUnavailable}
                                            onClick={(event) => {
                                                setFullCleanupModeMenuAnchorEl(event.currentTarget);
                                            }}
                                            color="inherit"
                                            style={{height: "3.5em", borderColor: "inherit"}}
                                            aria-label="Select full cleanup mode"
                                            aria-haspopup="menu"
                                            aria-expanded={fullCleanupModeMenuOpen ? "true" : undefined}
                                        >
                                            <ArrowDropDownIcon />
                                        </Button>
                                    )}
                                    {buttons.map(({ label, command, enabled, Icon }) => {
                                        return (

                                            <Button
                                                key={command}
                                                variant="outlined"
                                                size="medium"
                                                disabled={!enabled || isPending}
                                                onClick={() => {
                                                    sendCommand(command);
                                                }}
                                                color="inherit"
                                                style={{height: "3.5em", borderColor: "inherit"}}
                                                aria-label={label}
                                            >
                                                <Icon />
                                            </Button>
                                        );
                                    })}
                                </ButtonGroup >
                                {segmentPreferencesApplyControlSupported && segmentPreferencesApplyControlError && (
                                    <Typography variant="caption" color="error">
                                        Could not load the full cleanup mode.
                                    </Typography>
                                )}
                                {segmentPreferencesApplyControlSupported &&
                                    selectedFullCleanupMode === "segment_preferences" && flag !== "resumable" && (
                                    <Typography variant="caption" color="text.secondary">
                                        If the robot localizes on another saved map, it restarts using that map&apos;s
                                        room-specific settings.
                                    </Typography>
                                )}
                            </Grid2>
                        </Grid2>
                    </Box>
                </Paper>
            </Grid2>

            <Menu
                anchorEl={fullCleanupModeMenuAnchorEl}
                open={fullCleanupModeMenuOpen}
                onClose={() => {
                    setFullCleanupModeMenuAnchorEl(null);
                }}
            >
                <MenuItem
                    selected={selectedFullCleanupMode === "segment_preferences"}
                    onClick={() => {
                        setSelectedFullCleanupMode("segment_preferences");
                        setFullCleanupModeSelectionDirty(true);
                        setFullCleanupModeMenuAnchorEl(null);
                    }}
                >
                    Room-specific settings
                </MenuItem>
                <MenuItem
                    selected={selectedFullCleanupMode === "common"}
                    onClick={() => {
                        setSelectedFullCleanupMode("common");
                        setFullCleanupModeSelectionDirty(true);
                        setFullCleanupModeMenuAnchorEl(null);
                    }}
                >
                    Common settings
                </MenuItem>
            </Menu>

            <ConfirmationDialog
                title="Are you sure you want to start a full cleanup?"
                open={startConfirmationDialogOpen}
                onClose={() => {
                    setStartConfirmationDialogOpen(false);
                }}
                onAccept={() => {
                    startFullCleanup().catch(() => undefined);
                }}>
                <DialogContentText>
                    You currently have a pending MapAction.
                    <br/>
                    <br/>
                    <strong>Hint:</strong>
                    <br/>
                    You might instead be looking for the button on the bottom right of the map.
                </DialogContentText>
            </ConfirmationDialog>
        </>
    );
};

export default BasicControls;
