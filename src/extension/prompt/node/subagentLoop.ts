/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { CancellationToken, ChatRequest, ChatResponseStream, LanguageModelChat, LanguageModelToolInformation, Progress } from 'vscode';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { ChatLocation, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseProgressPart, ChatResponseReferencePart, LanguageModelTextPart, LanguageModelToolResult2 } from '../../../vscodeTypes';
import { getAgentTools } from '../../intents/node/agentIntent';
import { IToolCallingLoopOptions, ToolCallingLoop, ToolCallingLoopFetchOptions } from '../../intents/node/toolCallingLoop';
import { AgentPrompt } from '../../prompts/node/agent/agentPrompt';
import { PromptElementCtor } from '../../prompts/node/base/promptElement';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../../tools/common/toolNames';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { IBuildPromptContext } from '../common/intents';
import { IBuildPromptResult } from './intents';

export interface ISubagentToolCallingLoopOptions extends IToolCallingLoopOptions {
	request: ChatRequest;
	location: ChatLocation;
	promptText: string;
	/** Optional: if provided, only these tools will be available to the subagent */
	allowedTools?: Set<ToolName>;
	/** Optional: custom prompt class to use instead of AgentPrompt */
	customPromptClass?: PromptElementCtor;
}

export class SubagentToolCallingLoop extends ToolCallingLoop<ISubagentToolCallingLoopOptions> {

	public static readonly ID = 'subagent';

	constructor(
		options: ISubagentToolCallingLoopOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IRequestLogger requestLogger: IRequestLogger,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IAuthenticationChatUpgradeService authenticationChatUpgradeService: IAuthenticationChatUpgradeService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(options, instantiationService, endpointProvider, logService, requestLogger, authenticationChatUpgradeService, telemetryService);
	}

	protected override createPromptContext(availableTools: LanguageModelToolInformation[], outputStream: ChatResponseStream | undefined): IBuildPromptContext {
		const context = super.createPromptContext(availableTools, outputStream);
		
		// Log tool results available in context
		if (context.toolCallResults && Object.keys(context.toolCallResults).length > 0) {
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			this._logService.info('[SubagentToolCallingLoop] TOOL RESULTS AVAILABLE IN CONTEXT');
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			for (const [toolCallId, result] of Object.entries(context.toolCallResults)) {
				this._logService.info(`[SubagentToolCallingLoop] Tool Call ID: ${toolCallId}`);
				if (result instanceof LanguageModelToolResult2) {
					this._logService.info(`[SubagentToolCallingLoop]   Content parts: ${result.content.length}`);
					result.content.forEach((part, idx) => {
						if (part instanceof LanguageModelTextPart) {
							this._logService.info(`[SubagentToolCallingLoop]   Part ${idx + 1}: Text (length: ${part.value.length})`);
							this._logService.info(`[SubagentToolCallingLoop]   Full text:`, part.value);
						} else {
							this._logService.info(`[SubagentToolCallingLoop]   Part ${idx + 1}: ${part.constructor.name}`);
						}
					});
				} else {
					this._logService.info(`[SubagentToolCallingLoop]   Result type: ${typeof result}`);
					this._logService.info(`[SubagentToolCallingLoop]   Result:`, result);
				}
			}
			this._logService.info('[SubagentToolCallingLoop] ========================================');
		}
		
		if (context.tools) {
			context.tools = {
				...context.tools,
				toolReferences: [],
				inSubAgent: true
			};
		}
		context.query = this.options.promptText;
		context.chatVariables = new ChatVariablesCollection();
		// Only clear conversation if using default AgentPrompt (no custom prompt class)
		if (!this.options.customPromptClass) {
			context.conversation = undefined;
		}
		return context;
	}

	private async logAvailableModels() {
		try {
			// Log all available chat endpoints
			const allEndpoints = await this.endpointProvider.getAllChatEndpoints();
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			this._logService.info('[SubagentToolCallingLoop] Available chat endpoints:');
			this._logService.info('[SubagentToolCallingLoop] ========================================');
			for (const ep of allEndpoints) {
				this._logService.info(`[SubagentToolCallingLoop]   - ${ep.model} (family: ${ep.family}, toolCalls: ${ep.supportsToolCalls}, vendor: ${ep.isExtensionContributed ? 'extension' : 'copilot'})`);
			}
			this._logService.info('[SubagentToolCallingLoop] ========================================');
		} catch (error) {
			this._logService.warn('[SubagentToolCallingLoop] Failed to list available models:', error);
		}
	}

	private async getEndpoint(request: ChatRequest) {
		// Log available models for debugging
		await this.logAvailableModels();

		// Define the model to use for search subagent
		// This should match a model configured in github.copilot.chat.customOAIModels setting
		const modelSelector = {
			vendor: 'customoai',
			id: 'qwen3-4b'
		};
		
		this._logService.info('[SubagentToolCallingLoop] Attempting to select model:', JSON.stringify(modelSelector, null, 2));
		
		try {
			// Use vscode.lm.selectChatModels to get the actual registered model
			const models = await vscode.lm.selectChatModels(modelSelector);
			
			if (!models || models.length === 0) {
				const errorMsg = `No models found matching selector: ${JSON.stringify(modelSelector)}. Ensure the model is configured in github.copilot.chat.customOAIModels setting.`;
				this._logService.error(`[SubagentToolCallingLoop] ${errorMsg}`);
				throw new Error(errorMsg);
			}
			
			const qwenModel = models[0];
			this._logService.info('[SubagentToolCallingLoop] Selected model from VS Code:', JSON.stringify({
				vendor: qwenModel.vendor,
				id: qwenModel.id,
				name: qwenModel.name,
				family: qwenModel.family,
				hasCapabilities: !!qwenModel.capabilities,
				supportsToolCalling: qwenModel.capabilities?.supportsToolCalling
			}, null, 2));
			
			// Pass the actual registered model to getChatEndpoint
			const endpoint = await this.endpointProvider.getChatEndpoint(qwenModel);
			
			this._logService.info('[SubagentToolCallingLoop] Successfully selected endpoint:', {
				requestedModelId: modelSelector.id,
				requestedModelVendor: modelSelector.vendor,
				endpointModel: endpoint.model,
				endpointFamily: endpoint.family,
				supportsToolCalls: endpoint.supportsToolCalls,
				supportsVision: endpoint.supportsVision,
				isExtensionContributed: endpoint.isExtensionContributed
			});
			
			if (!endpoint.supportsToolCalls) {
				const errorMsg = `Selected model ${qwenModel.id} does not support tool calls, which is required for search subagent`;
				this._logService.error(`[SubagentToolCallingLoop] ${errorMsg}`);
				throw new Error(errorMsg);
			}
			
			return endpoint;
		} catch (error) {
			// Log full error details and throw instead of falling back
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			this._logService.error('[SubagentToolCallingLoop] FAILED TO GET ENDPOINT');
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			this._logService.error('[SubagentToolCallingLoop] Requested model selector:', JSON.stringify(modelSelector, null, 2));
			this._logService.error('[SubagentToolCallingLoop] Error type:', error?.constructor?.name);
			this._logService.error('[SubagentToolCallingLoop] Error message:', error instanceof Error ? error.message : String(error));
			this._logService.error('[SubagentToolCallingLoop] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
			this._logService.error('[SubagentToolCallingLoop] ========================================');
			throw new Error(`Failed to get endpoint for search subagent with model ${modelSelector.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	protected async buildPrompt(promptContext: IBuildPromptContext, progress: Progress<ChatResponseReferencePart | ChatResponseProgressPart>, token: CancellationToken): Promise<IBuildPromptResult> {
		const endpoint = await this.getEndpoint(this.options.request);
		const PromptClass = (this.options.customPromptClass ?? AgentPrompt) as typeof AgentPrompt;
		const renderer = PromptRenderer.create(
			this.instantiationService,
			endpoint,
			PromptClass,
			{
				endpoint,
				promptContext: promptContext,
				location: this.options.location,
				enableCacheBreakpoints: false,
			}
		);
		return await renderer.render(progress, token);
	}

	protected async getAvailableTools(): Promise<LanguageModelToolInformation[]> {
		const allTools = await this.instantiationService.invokeFunction(getAgentTools, this.options.request);

		if (this.options.allowedTools) {
			// If allowedTools is specified, only include those tools
			return allTools.filter(tool => this.options.allowedTools!.has(tool.name as ToolName));
		} else {
			// Default behavior: exclude certain tools
			const excludedTools = new Set([ToolName.CoreRunSubagent, ToolName.CoreManageTodoList]);
			return allTools
				.filter(tool => !excludedTools.has(tool.name as ToolName))
				// TODO can't do virtual tools at this level
				.slice(0, 128);
		}
	}

	protected async fetch({ messages, finishedCb, requestOptions }: ToolCallingLoopFetchOptions, token: CancellationToken): Promise<ChatResponse> {
		const endpoint = await this.getEndpoint(this.options.request);
		return endpoint.makeChatRequest2({
			debugName: SubagentToolCallingLoop.ID,
			messages,
			finishedCb,
			location: this.options.location,
			requestOptions: {
				...(requestOptions ?? {}),
				temperature: 0,
				tools: normalizeToolSchema(
					endpoint.family,
					requestOptions?.tools,
					(tool, rule) => {
						this._logService.warn(`Tool ${tool} failed validation: ${rule}`);
					},
				),
			},
			// This loop is inside a tool called from another request, so never user initiated
			userInitiatedRequest: false,
			telemetryProperties: {
				messageId: randomUUID(),
				messageSource: SubagentToolCallingLoop.ID
			},
		}, token);
	}
}
