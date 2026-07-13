export interface IncompleteNodeMessageInput {
  nodeId: string;
  completeToolName: "__graph_complete__";
}

export interface DeadRunMessageInput {
  nodeId: string | null;
}

export interface GraphFailureMessageInput {
  graphId: string;
  reason: string;
}

export interface ModelMessageFormatter {
  incompleteNode(input: IncompleteNodeMessageInput): string;
  deadRun(input: DeadRunMessageInput): string;
  graphFailure(input: GraphFailureMessageInput): string;
}

export const defaultModelMessageFormatter: ModelMessageFormatter = {
  incompleteNode() {
    return "Agent finished without calling __graph_complete__.";
  },
  deadRun() {
    return "[系统] 当前图已终止，你的后续操作不会被接收。";
  },
  graphFailure(input) {
    return `[系统] 图 "${input.graphId}" 因错误意外终止：${input.reason}。当前节点已失效，请停止相关图工作。`;
  },
};
