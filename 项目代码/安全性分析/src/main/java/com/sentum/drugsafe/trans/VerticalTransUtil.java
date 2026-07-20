package com.sentum.drugsafe.trans;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import lombok.extern.slf4j.Slf4j;

import java.util.Map;

@Slf4j
public class VerticalTransUtil {
    public static String getTransResult(String word){
        VerticalTransApi verticalTransApi = new VerticalTransApi();
        boolean judgeChinese = GetMaxSimilarUtil.judgeChinese(word);
        String transResult;
        if (judgeChinese){
            //中文翻译成英文
            transResult = verticalTransApi.getTransResult(word, "zh", "en");
        }else {
            //英文翻译成中文
            transResult = verticalTransApi.getTransResult(word, "en", "zh");
        }
        JSONObject jsonObject = JSONObject.parseObject(transResult);
        if (jsonObject.containsKey("trans_result")){
            JSONObject result = jsonObject.getJSONArray("trans_result").getJSONObject(0);
            return result.getString("dst");
        }
        //调用腾讯翻译
        log.info("百度企业合作翻译异常-启用腾讯翻译");
        TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
        String from;
        String to;
        if (GetMaxSimilarUtil.judgeChinese(word)){
            from = "zh";
            to = "en";
        }else {
            from = "en";
            to = "zh";
        }
        Map<String, String> transResultMap = tencentTranSmartApi.getTransResult(word, from, to);
        if ("1".equals(transResultMap.get("code"))){
            word = transResultMap.get("result");
        }else {
            //使用免费的翻译接口进行补充翻译
            log.info("腾讯翻译异常-启用百度免费翻译");
            word = TransUtil.getTransResult(word);
        }
        return word;
    }

    public static String getTransResultJp(String word){
        VerticalTransApi verticalTransApi = new VerticalTransApi();
        boolean judgeChinese = GetMaxSimilarUtil.judgeChinese(word);
        String transResult;
        if (judgeChinese){
            //中文翻译成英文
            transResult = verticalTransApi.getTransResult(word, "zh", "en");
        }else {
            //英文翻译成中文
            transResult = verticalTransApi.getTransResult(word, "en", "zh");
        }
        JSONObject jsonObject = JSONObject.parseObject(transResult);
        if (jsonObject.containsKey("trans_result")){
            JSONObject result = jsonObject.getJSONArray("trans_result").getJSONObject(0);
            return result.getString("dst");
        }
        //调用腾讯翻译
        log.info("百度企业合作翻译异常-启用腾讯翻译");
        TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
        String from;
        String to;
        from = "jp";
        to = "zh";
        Map<String, String> transResultMap = tencentTranSmartApi.getTransResult(word, from, to);
        if ("1".equals(transResultMap.get("code"))){
            word = transResultMap.get("result");
        }else {
            //使用免费的翻译接口进行补充翻译
            log.info("腾讯翻译异常-启用百度免费翻译");
            word = TransUtil.getTransResult(word);
        }
        return word;
    }



}
