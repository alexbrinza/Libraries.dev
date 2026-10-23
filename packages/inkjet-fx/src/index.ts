export { InkText } from './InkText';
export { InkImage } from './InkImage';

export type {
  InkImageHandle,
  InkImageLook,
  InkImageProps,
  InkImageScreen,
  InkTextHandle,
  InkTextLook,
  InkTextProps,
  InkTextThinking
} from './types';

// Power-user surface: the engines work on any element without React.
export { InkTextEngine, printStream, TEXT_LOOKS, TEXT_THINKING, type InkTextOptions } from './engine/ink-text';
export { InkImageEngine, IMAGE_LOOKS, IMAGE_SCREENS, type InkImageOptions } from './engine/ink-image';
