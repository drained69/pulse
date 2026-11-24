import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import {Composition} from 'remotion';
import {Demo} from './Video';
import timing from './generated/timing.json';
export const Root=()=> <><Composition id="QPulseLandscape" component={Demo} width={1920} height={1080} fps={30} durationInFrames={timing.frames}/><Composition id="QPulsePortrait" component={Demo} width={1080} height={1920} fps={30} durationInFrames={timing.frames}/></>;
