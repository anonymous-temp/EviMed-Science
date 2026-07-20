package com.sentum.util;

import lombok.extern.slf4j.Slf4j;

import java.util.HashMap;
import java.util.Map;

/**
 * 垂直医学领域翻译接口api
 * @author zgm
 */
@Slf4j
public class VerticalTransApi {
    private static final String TRANS_API_HOST = "https://fanyi-api.baidu.com/api/trans/vip/fieldtranslate";
    private static final String APP_ID = "20220414001172477";
    private static final String SECURITY_KEY = "lkAOQIYH7nB6hBShX4Ub";
    private static final Long TIME = 1000L;

    public String getTransResult(String query, String from, String to) {
        Map<String, String> params = buildParams(query, from, to);
        return HttpGetUtil.get(TRANS_API_HOST, params);
    }

    private Map<String, String> buildParams(String query, String from, String to) {
        Map<String, String> params = new HashMap<>();
        params.put("q", query);
        params.put("from", from);
        params.put("to", to);
        params.put("domain", "medicine");
        params.put("appid", APP_ID);

        // 随机数
        String salt = String.valueOf(System.currentTimeMillis());
        params.put("salt", salt);

        // 签名
        //加密前的原文
        String src = APP_ID + query + salt + "medicine" + SECURITY_KEY;
        params.put("sign", SecurityUtil.getMd5(src));
        return params;
    }
}
