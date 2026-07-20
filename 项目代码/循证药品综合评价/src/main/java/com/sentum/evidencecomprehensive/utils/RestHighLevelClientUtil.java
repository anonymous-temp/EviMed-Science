package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.date.DateTime;
import com.alibaba.fastjson.JSON;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.action.search.*;
import org.elasticsearch.client.RequestOptions;
import org.elasticsearch.client.RestHighLevelClient;
import org.elasticsearch.common.unit.TimeValue;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.search.SearchHit;
import org.elasticsearch.search.SearchHits;
import org.elasticsearch.search.builder.SearchSourceBuilder;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Map;

/**
 * Description: restHighLevelClient 简单查询 接口类
 * DateTime: 2024/3/29
 */
@Slf4j
public class RestHighLevelClientUtil {

    /**
     * 滚动检索
     * @param restHighLevelClient el 模板
     * @param paperQueryTemp 查询条件
     * @param dupNum 重复文献数量
     * @param count 目的计算检索到的文献数量
     */
    public static Long getDupNum(RestHighLevelClient restHighLevelClient, BoolQueryBuilder paperQueryTemp, long dupNum, long count) {
        long dupNumResult = dupNum;
        DateTime dateTime = new DateTime();
        // 构建SearchRequest以启动Scroll搜索
        SearchRequest searchRequest = new SearchRequest("literature_index_wsz"); // 替换为你的索引名
        SearchSourceBuilder searchSourceBuilder = new SearchSourceBuilder();
        searchSourceBuilder.query(paperQueryTemp);
        // 设置一次查询数量  越大查询越慢
        searchSourceBuilder.size(2000);
        // 设置Scroll超时时间，例如1分钟
        searchRequest.scroll(new TimeValue(60000)); // 可根据需要调整滚动时间
        searchRequest.source(searchSourceBuilder);
        // 执行初始的Scroll搜索请求
        SearchResponse searchResponse = null;
        try {
            searchResponse = restHighLevelClient.search(searchRequest, RequestOptions.DEFAULT);
            // 初始化Scroll ID，从首次响应中获取
            String scrollId = searchResponse.getScrollId();
            while (true) {
                // 使用Scroll ID执行下一次Scroll请求
                SearchScrollRequest scrollRequest = new SearchScrollRequest(scrollId);
                scrollRequest.scroll(new TimeValue(60000)); // 维持相同的滚动时间
                // 获取下一个批次的结果
                SearchResponse scrollResp = null;
                try {
                    scrollResp = restHighLevelClient.scroll(scrollRequest, RequestOptions.DEFAULT);
                    // 处理搜索结果
                    SearchHits hits = scrollResp.getHits();
                    for (SearchHit hit : hits) {
                        Map<String, Object> sourceAsMap = hit.getSourceAsMap();
                        try {
                            dupNumResult += JSON.parseObject(JSON.toJSONString(sourceAsMap.get("dupNum")), Long.class);
                            count++;
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                        }
                        log.info("dupNum 重复目前数量为{}, 筛选文献数量 {}", dupNumResult, count);
                        System.out.println();
                    }
                    // 检查是否有更多结果
                    if (scrollResp.getHits().getHits().length == 0) {
                        // 若没有更多结果，跳出循环
                        break;
                    }

                    // 更新Scroll ID，准备下一轮迭代
                    scrollId = scrollResp.getScrollId();
                } catch (IOException e) {
                    log.error(e.getMessage(), e);
                }
            }

            log.info("dupNum 重复总数量为{}", dupNumResult);
            log.info("执行总时间为：{}", new DateTime().getTime() - dateTime.getTime());
            // 完成后清理Scroll上下文
            ClearScrollRequest clearScrollRequest = new ClearScrollRequest();
            clearScrollRequest.addScrollId(scrollId);
            restHighLevelClient.clearScroll(clearScrollRequest, RequestOptions.DEFAULT);
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
        return dupNumResult;
    } 
}
