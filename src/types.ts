// `bash32` is bash 3.2, which finds the end of $(…) without reading the here-documents inside it.
export interface Mode { comments: boolean, heredocs: 'on' | 'off' | 'bash32' }

// `owner` is the command the body feeds; it is set when that command's text ends, before the body is read.
export interface Doc { delim: string, strip: boolean, quoted: boolean, owner?: Found }

// `stdin` is the here-document body the command reads, or null when the body holds an expansion.
export interface Found { start: number, text: string, stdin?: string | null }

// `subs` holds the source of each $(…) in the order read; a segment refers to one by index (see `SUB`).
export interface Sink { found: Found[], subs: string[] }
