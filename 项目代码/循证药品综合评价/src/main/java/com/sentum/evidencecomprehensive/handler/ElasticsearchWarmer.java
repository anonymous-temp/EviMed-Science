package com.sentum.evidencecomprehensive.handler;

import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.core.env.Environment;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/10/14
 */
@Slf4j
@Component
@RequiredArgsConstructor
@EnableAsync
public class ElasticsearchWarmer {

    private final ElasticsearchRestTemplate elasticsearchRestTemplate;
    private final Environment environment;

    @PostConstruct
    public void init() {
        if (Boolean.parseBoolean(environment.getProperty("elasticsearch.warmup.enabled", "true"))) {
            // 立即执行一次预热（应用启动时）
            warmupElasticsearch();
        }
    }


    // 每天早晨7:55执行（根据您的业务时间调整）
//    @Scheduled(cron = "${elasticsearch.warmup.cron:0 0 8 * * ?}")
//    @Scheduled(cron = "0 55 7 * * ?")
    @Scheduled(cron = "0 */3 * * * ?")
    public void scheduledWarmup() {
        warmupElasticsearch();
    }

    private void warmupElasticsearch() {
        try {
            // 执行一个简单的查询来预热连接
            NativeSearchQuery query = new NativeSearchQueryBuilder()
                    .withQuery(QueryBuilders.matchAllQuery())
                    .withPageable(PageRequest.of(0, 1))
                    .build();

            elasticsearchRestTemplate.search(query, GuideIndex.class);
            log.info("✅ Elasticsearch connection warmed up successfully");
        } catch (Exception e) {
            log.error("❌ Failed to warm up Elasticsearch connection", e);
        }
    }
}

