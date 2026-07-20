package com.sentum.util;

import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;

import java.util.HashMap;
import java.util.Map;

/**
 * 腾讯翻译工具类
 * @author zgm
 */
@Slf4j
public class TencentTranSmartApi {
    private static final String TRANS_API_HOST = "https://transmart.qq.com/api/imt";
    /*private static final String USER = "qq_701925bda334";
    private static final String TOKEN = System.getenv("TENCENT_TRANSMART_TOKEN");*/
    //公司账号
    private static final String USER = "lxyl";
    private static final String TOKEN = System.getenv("TENCENT_TRANSMART_TOKEN");

    public TencentTranSmartApi() {
    }

    public static void main(String[] args) {
        TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
        Map<String, String> transResult = tencentTranSmartApi.getTransResult("ovarian cancer", "en", "zh");
        System.out.println(transResult);
    }

    public Map<String, String> getTransResult(String query, String from, String to) {
        Map<String, String> map = new HashMap<>();
        Map<String, Map<String, String>> stringMapMap = buildParams(query, from, to);
        String sendPost = SendPostUtil.sendPost(TRANS_API_HOST, JSONObject.toJSONString(stringMapMap));
        JSONObject jsonObject = JSONObject.parseObject(sendPost);
        if (jsonObject != null){
            Object object = jsonObject.get("header");
            if (object != null) {
                JSONObject jsonObject1 = JSONObject.parseObject(JSONObject.toJSONString(object));
                Object retCode = jsonObject1.get("ret_code");
                if (retCode != null) {
                    String retCodeString = retCode.toString();
                    if ("succ".equals(retCodeString)) {
                        map.put("code", "1");
                        map.put("result", jsonObject.get("auto_translation").toString());
                    }else if ("busy".equals(retCodeString)){
                        map.put("code", "0");
                        log.info("启动腾讯二次翻译");
                        Map<String, Map<String, String>> stringMapMap2 = buildParams2(query, from, to);
                        String sendPost2 = SendPostUtil.sendPost(TRANS_API_HOST, JSONObject.toJSONString(stringMapMap2));
                        JSONObject jsonObject2 = JSONObject.parseObject(sendPost2);
                        if (jsonObject2 != null){
                            Object object2 = jsonObject2.get("header");
                            if (object2 != null) {
                                JSONObject jsonObject3 = JSONObject.parseObject(JSONObject.toJSONString(object2));
                                Object retCode2 = jsonObject3.get("ret_code");
                                if (retCode2 != null) {
                                    String retCodeString2 = retCode2.toString();
                                    if ("succ".equals(retCodeString2)) {
                                        map.put("code", "1");
                                        map.put("result", jsonObject2.get("auto_translation").toString());
                                    }else {
                                        log.info("等待1s再次翻译");
                                        try {
                                            Thread.sleep(1000);
                                            stringMapMap = buildParams(query, from, to);
                                            sendPost = SendPostUtil.sendPost(TRANS_API_HOST, JSONObject.toJSONString(stringMapMap));
                                            jsonObject = JSONObject.parseObject(sendPost);
                                            if (jsonObject != null) {
                                                object = jsonObject.get("header");
                                                if (object != null) {
                                                    jsonObject1 = JSONObject.parseObject(JSONObject.toJSONString(object));
                                                    retCode = jsonObject1.get("ret_code");
                                                    if (retCode != null) {
                                                        retCodeString = retCode.toString();
                                                        if ("succ".equals(retCodeString)) {
                                                            map.put("code", "1");
                                                            map.put("result", jsonObject.get("auto_translation").toString());
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (InterruptedException e) {
                                            e.printStackTrace();
                                        }
                                    }
                                }
                            }
                        }
                    }else {
                        map.put("code", "2");
                    }
                }
            }
        }
        return map;
    }

    private Map<String, Map<String, String>> buildParams(String query, String from, String to) {
        Map<String, Map<String, String>> params = new HashMap<>();
        Map<String, String> headerMap = new HashMap<>();
        headerMap.put("fn", "auto_translation_block");
        headerMap.put("user", USER);
        headerMap.put("token", TOKEN);
        params.put("header", headerMap);
        Map<String, String> sourceMap = new HashMap<>();
        sourceMap.put("lang", from);
        sourceMap.put("text_block", query);
        params.put("source", sourceMap);
        Map<String, String> targetMap = new HashMap<>();
        targetMap.put("lang", to);
        params.put("target", targetMap);
        return params;
    }

    private Map<String, Map<String, String>> buildParams2(String query, String from, String to) {
        Map<String, Map<String, String>> params = new HashMap<>();
        Map<String, String> headerMap = new HashMap<>();
        headerMap.put("fn", "auto_translation_block");
        headerMap.put("user", "qq_701925bda334");
        headerMap.put("token", TOKEN);
        params.put("header", headerMap);
        Map<String, String> sourceMap = new HashMap<>();
        sourceMap.put("lang", from);
        sourceMap.put("text_block", query);
        params.put("source", sourceMap);
        Map<String, String> targetMap = new HashMap<>();
        targetMap.put("lang", to);
        params.put("target", targetMap);
        return params;
    }
}
