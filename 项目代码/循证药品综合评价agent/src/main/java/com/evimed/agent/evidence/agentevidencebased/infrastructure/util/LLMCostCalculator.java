package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import lombok.Data;
import org.springframework.ai.chat.metadata.Usage;

/**
 * LLM 成本计算器（qwen-plus 价格）
 */
public class LLMCostCalculator {

    // qwen-plus 价格（元/百万 tokens）
    private static final double INPUT_PRICE = 0.8;
    private static final double OUTPUT_PRICE = 2.0;

    @Data
    public static class CostStats {
        private long inputTokens;
        private long outputTokens;
        private double totalCost;

        public void add(Usage usage) {
            if (usage != null) {
                this.inputTokens += usage.getPromptTokens();
                this.outputTokens += usage.getCompletionTokens();
            }
        }

        public void addEstimated(String input, String output) {
            this.inputTokens += estimateTokens(input);
            this.outputTokens += estimateTokens(output);
        }

        public void calculate() {
            this.totalCost = (inputTokens * INPUT_PRICE + outputTokens * OUTPUT_PRICE) / 1_000_000.0;
        }

        public String format() {
            return String.format("输入: %,d tokens, 输出: %,d tokens, 成本: ¥%.4f",
                    inputTokens, outputTokens, totalCost);
        }
    }

    public static CostStats createStats() {
        return new CostStats();
    }

    /**
     * 估算文本的 token 数量（粗略估算）
     * 中文约 1.5 字符/token，英文约 4 字符/token
     */
    private static long estimateTokens(String text) {
        if (text == null || text.isEmpty()) return 0;

        int chineseCount = 0;
        int otherCount = 0;

        for (char c : text.toCharArray()) {
            if (c >= 0x4E00 && c <= 0x9FA5) {
                chineseCount++;
            } else {
                otherCount++;
            }
        }

        return (long) (chineseCount / 1.5 + otherCount / 4.0);
    }
}
