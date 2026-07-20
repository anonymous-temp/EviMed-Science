package com.sentum.drugsafe.trans;

import cn.hutool.http.HttpUtil;
import lombok.extern.slf4j.Slf4j;

import java.util.HashMap;
import java.util.Map;

/**
 * 接入百度翻译API
 * @author lilingling
 * @since 2020-07-28
 */
@Slf4j
public class TransApi {
    //private static final String TRANS_API_HOST = "http://api.fanyi.baidu.com/api/trans/vip/translate";
    private static final String TRANS_API_HOST = "https://fanyi-api.baidu.com/api/trans/vip/translate";
    //private static final String APP_ID = "20201027000600029";
    //private static final String SECURITY_KEY = "xqurZReQU_MarnQqWUHx";

    private static final String APP_ID = "20210817000919568";
    private static final String SECURITY_KEY = "EUrQNKFIoA7L3Lnlqv0v";

    //private static final String APP_ID = "20200630000509939";
    //private static final String SECURITY_KEY = "iXxSrJWkG3jnPpWeZWut";

    //private static final String APP_ID = "20210223000704911";
    //private static final String SECURITY_KEY = "hclmPaPu72tAul6GKPCW";

    /**
     * 记录上次访问时间
     */
    private long t;

    public TransApi(long t){
        this.t = t;
    }

    public String getTransResult(String query, String from, String to) {
        Map<String, Object> params = buildParams(query, from, to);
        long l1 = System.currentTimeMillis();
        if (l1 - t < 1000){
            //距上次请求不足1s，需等待
            try {
                Thread.sleep(t + 1000 - l1);
                log.info("翻译正在等待...");
            } catch (Exception e){
                return null;
            }
        }
        return HttpUtil.get(TRANS_API_HOST, params);
    }

    private Map<String, Object> buildParams(String query, String from, String to) {
        Map<String, Object> params = new HashMap<>();
        params.put("q", query);
        params.put("from", from);
        params.put("to", to);
        params.put("appid", APP_ID);

        // 随机数
        String salt = String.valueOf(System.currentTimeMillis());
        params.put("salt", salt);

        // 签名
        //加密前的原文
        String src = APP_ID + query + salt + SECURITY_KEY;
        params.put("sign", SecurityUtil.getMd5(src));
        return params;
    }
}
