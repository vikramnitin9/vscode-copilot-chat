/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatPrepareToolInvocationPart, ChatResponseNotebookEditPart, ChatResponseTextEditPart, ExtendedLanguageModelToolResult, LanguageModelTextPart } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SubagentToolCallingLoop } from '../../prompt/node/subagentLoop';
import { ExecutionSubagentPrompt } from '../../prompts/node/agent/executionSubagentPrompt';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IExecutionSubagentParams {

	/** Natural language query describing what to execute */
	command: string;
	/** Objective describing what is to be determined from the command output */
	objective: string;
	/** User-visible description shown while invoking */
	description: string;
}

class ExecutionSubagentTool implements ICopilotTool<IExecutionSubagentParams> {
	public static readonly toolName = ToolName.ExecutionSubagent;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }
	async invoke(options: vscode.LanguageModelToolInvocationOptions<IExecutionSubagentParams>, token: vscode.CancellationToken) {
		const executionInstruction = [
			`Command: ${options.input.command}`,
			`Objective: ${options.input.objective}`,
			'',
			'You are a specialized execution subagent. Your task is to execute the above command and extract relevant excerpts of its output according to the purpose described in the objective.',
			'You have access to just one tool:',
			'- run_in_terminal: Executes a command in the terminal and returns the output.',
			'',
			'After completing your search, return ONLY a valid JSON array of the most relevant execution output excerpts in this exact format:',
			'[',
			'  {',
			'    "output": "Excerpt of the command output here"',
			' 	 "return_code": 0',
			'  }',
			']',
			'',
			'Include only the most relevant excerpts that would help satisfy the objective.',
			'The "return_code" field should capture the command\'s return code.',
			'The `output` can be an empty string if there is no relevant output.',
			'Do not include any explanation or additional text, only the JSON array.',
			''
		].join('\n');

		const loop = this.instantiationService.createInstance(SubagentToolCallingLoop, {
			toolCallLimit: 25,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: executionInstruction })]),
			request: this._inputContext!.request!,
			location: this._inputContext!.request!.location,
			promptText: options.input.command,
			allowedTools: new Set([ToolName.CoreRunInTerminal]),
			customPromptClass: ExecutionSubagentPrompt,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatPrepareToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		const loopResult = await loop.run(stream, token);

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The search subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IExecutionSubagentParams>, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: options.input.description,
		};
	}

	async resolveInput(input: IExecutionSubagentParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IExecutionSubagentParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(ExecutionSubagentTool);
