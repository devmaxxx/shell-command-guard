// `bash32` is bash 3.2, which finds the end of $(…) without reading the here-documents inside it.
export interface Mode { comments: boolean, heredocs: 'on' | 'off' | 'bash32' }

export interface Doc { delim: string, strip: boolean, quoted: boolean }

export interface Found { start: number, text: string }
