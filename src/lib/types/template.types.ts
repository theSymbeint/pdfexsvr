export  type Page = {
    orientation: 'portrait' | 'landscape'
    format: string | [] //"a4", "letter (8.5*11)", "legal (8.5*14), a0 - a10, ledger"
    baseFont?: string
    baseFontSize?: number
    baseFontColor?: string
    baseFontStyle?: 'normal' | 'bold' | 'italic'
    bgImages?: Array<Image>
    images?: Array<Image>
    fonts?: Array<Font>
    shapes?: Array<Shape>
    labels?: Array<Label>
    data: Array<Data>
}

export type Label = {
    text: string
    x: number
    y: number
    type: 'string' | 'number' | 'date'
    font: any
    color?: string
    fontSize?: number
    format?: string
}

export type Data = {
    name: string
    x: number
    y: number
    type: 'string' | 'number' | 'date'
    font?: string
    fontSize?: number
    color?: string
    format?: string
}

export type Font = {
    fontId: string
    fontFile: string
}

export type Shape = {
    type: 'line' | 'rect' | 'circle' | 'ellipse' | 'polygon'
    x: number
    y: number
    toX?: number
    toY?: number
    dash?: number
    space?: number
    fillColor?: string
    strokeColor?: string
    strokeOpacity?: number
    fillOpacity?: number
    lineWidth?: number
    width?: number
    height?: number
    cornerRadius?: number
    radius?: number
    points?: Array<Point>
}

export type Point = {
    x: number
    y: number
}

export type Image = {
    fileName?: string
    url?: string
    x?: number
    y?: number
    scale?: number
    width?: number
    height?: number
    fit?: Array<number>
}
