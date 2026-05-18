import type { ReactNode } from "react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../ai-elements/reasoning";
import { AssistantOutputCard } from "./AssistantOutputCard";

export interface AssistantThinkingCardProps {
  readonly content: string;
  readonly isStreaming?: boolean;
  readonly heading?: ReactNode;
}

export function AssistantThinkingCard({
  content,
  isStreaming = false,
  heading = "思考过程",
}: AssistantThinkingCardProps) {
  return (
    <AssistantOutputCard heading={heading}>
      <Reasoning isStreaming={isStreaming}>
        <ReasoningTrigger size="base" />
        <ReasoningContent size="base">{content}</ReasoningContent>
      </Reasoning>
    </AssistantOutputCard>
  );
}
