import { IDataObject, type IExecuteFunctions, INodeProperties, INodePropertyOptions } from 'n8n-workflow';

export type ResourceOperations = INodePropertyOptions & {
	options: INodeProperties[];
	call?: (this: IExecuteFunctions, index: number) => Promise<IDataObject>;
};

export interface IResource extends INodePropertyOptions{
	operations: ResourceOperations[]
}
