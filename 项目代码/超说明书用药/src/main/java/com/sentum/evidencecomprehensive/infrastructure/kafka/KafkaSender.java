package com.sentum.evidencecomprehensive.infrastructure.kafka;


import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.Resource;

/**
 * kafka生产者
 */
@Slf4j
@Component
public class KafkaSender {
    @Resource
    private KafkaTemplate<String,Object> kafkaTemplate;

    /**
     * ai方案发送数据
     */
    public void sendReportInfo(JSONObject dataJson){
        try {
            kafkaTemplate.send("wechat-report", dataJson);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
    }
}
