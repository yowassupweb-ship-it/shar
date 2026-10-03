declare module 'react-file-icon' {
  import * as React from 'react';
  export interface FileIconProps {
    extension?: string;
    [key: string]: unknown;
  }
  export const FileIcon: React.FC<FileIconProps>;
  export const defaultStyles: Record<string, Record<string, unknown>>;
}
