package com.evimed.agent.evidence.agentevidencebased.infrastructure.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;

/**
 * Agent 核心配置
 *
 * Agent 实例已迁移至 AgentDispatcher 按请求懒初始化，
 * Tavily 工具在 AgentDispatcher.afterPropertiesSet() 中手动初始化。
 */
@Slf4j
@Configuration
public class AgentConfig {
}
