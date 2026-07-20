package com.sentum.util;

import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.RequestBody;

@Component
@Slf4j
public class GptUtil {
    @Autowired
    private GptAiUtils gptAiUtils;


    public String generation(@RequestBody JSONObject dataJson) {
        long startTime = System.currentTimeMillis();
        String model = dataJson.getString("model");
        String infoChat;
        if (StringUtils.isNotBlank(model)) {
            JSONObject responseFormat = dataJson.getJSONObject("responseFormat");
            if (responseFormat != null) {
                infoChat = gptAiUtils.infoChatByTool(dataJson.getString("prompt"), model, responseFormat);
                log.info("gpt模型[{}]并格式化返回数据所用时间为{}", model, System.currentTimeMillis() - startTime);
            } else {
                infoChat = gptAiUtils.infoChat(dataJson.getString("prompt"), model);
                log.info("gpt模型[{}]所用时间为{}", model, System.currentTimeMillis() - startTime);
            }
        } else {
            //dataJson.getJSONObject("")
            //infoChat = gptAiUtils.infoChat(dataJson.getString("prompt"), "gpt-3.5-turbo-16k");
            infoChat = gptAiUtils.infoChat(dataJson.getString("prompt"));
            log.info("deepseek模型所用时间为{}", System.currentTimeMillis() - startTime);
        }
        //String infoChat = gptAiUtils.infoChat(dataJson.getString("prompt"));
        //log.info("deepseek模型所用时间为{}", System.currentTimeMillis() - startTime);
        //log.info("deepseek模型所用时间为{}", System.currentTimeMillis() - startTime);
        return infoChat;
    }

}
