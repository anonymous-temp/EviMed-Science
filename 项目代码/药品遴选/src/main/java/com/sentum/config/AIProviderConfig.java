package com.sentum.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * AI提供商配置
 * 支持从配置文件读取，也支持代码硬编码（向后兼容）
 */
@Data
@Component
@ConfigurationProperties(prefix = "ai")
public class AIProviderConfig {

    /**
     * 默认提供商：deepseek / qwen / openai
     */
    private String defaultProvider = "deepseek";

    /**
     * 默认模型
     */
    private String defaultModel = "deepseek-v4-pro";

    /**
     * 提供商配置映射
     */
    private Map<String, ProviderInfo> providers = new HashMap<>();

    /**
     * 任务特定模型映射（可选）
     */
    private Map<String, String> taskModels = new HashMap<>();

    /**
     * 超时配置（秒）
     */
    private TimeoutConfig timeout = new TimeoutConfig();

    @Data
    public static class ProviderInfo {
        private String url;
        private List<String> apiKeys = new ArrayList<>();
    }

    @Data
    public static class TimeoutConfig {
        private int connect = 60;
        private int read = 240;
        private int write = 60;
    }

    /**
     * 初始化默认配置（防止配置文件未配置时的降级方案）
     */
    public void initDefaults() {
        if (providers.isEmpty()) {
            // DeepSeek默认配置
            ProviderInfo deepseek = new ProviderInfo();
            deepseek.setUrl("https://api.deepseek.com/v1/chat/completions");
            deepseek.setApiKeys(Arrays.asList("sk-default-key"));
            providers.put("deepseek", deepseek);

            // Qwen默认配置（兼容现有）
            ProviderInfo qwen = new ProviderInfo();
            qwen.setUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
            qwen.setApiKeys(Arrays.asList("sk-default-key"));
            providers.put("qwen", qwen);
        }
    }

    /**
     * 获取任务对应的模型
     */
    public String getModelForTask(String taskName) {
        return taskModels.getOrDefault(taskName, defaultModel);
    }

    /**
     * 根据模型名推断提供商
     */
    public String getProviderForModel(String model) {
        if (model == null) {
            return defaultProvider;
        }

        if (model.startsWith("deepseek")) {
            return "deepseek";
        } else if (model.startsWith("qwen")) {
            return "qwen";
        } else if (model.startsWith("gpt")) {
            return "openai";
        }

        return defaultProvider;
    }

    /**
     * 获取提供商信息
     */
    public ProviderInfo getProvider(String provider) {
        initDefaults(); // 确保有默认值
        return providers.get(provider);
    }
}
