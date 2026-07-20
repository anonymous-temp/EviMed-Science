package com.sentum.evidencecomprehensive.service;

import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import okhttp3.*;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@Component
public class ERNIE_Bot {
    final static String ERNIE_ACCESS_TOKEN = "ernine_access_token";

    /**
     * 调用文心一言
     * @param msg 请求信息
     * @param type 1-3.5，2-4.0
     * @return 文心一言返回的数据
     * @throws IOException 异常
     */
    public String chat(String msg, Integer type) throws IOException {
        Map<String,Object> map = new HashMap<>();
        Object token = RedisUtil.redis.opsForValue().get(ERNIE_ACCESS_TOKEN);
        String accessToken;
        if(token!=null){
            accessToken = token.toString();
        }else {
            accessToken = getAccessToken();
        }
        Map<String,Object> content = new HashMap<>();
        content.put("role","user");
        content.put("content",msg);
        map.put("messages", Collections.singletonList(content));
        String res;
        if (type == 1) {
            //turbo
            res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/eb-instant?access_token="+accessToken, JSONObject.toJSONString(map));
        } else if (type == 2) {
            //4.0
            res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions_pro?access_token=" + accessToken, JSONObject.toJSONString(map));
        } else if (type == 3) {
            //32k
            res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/chatglm2_6b_32k?access_token=" + accessToken, JSONObject.toJSONString(map));
        } else {
            res = HttpUtil.post("https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/eb-instant?access_token="+accessToken, JSONObject.toJSONString(map));
        }
        System.out.println(res);
        return JSONObject.parseObject(res).getString("result");
    }

    private String getAccessToken() throws IOException {
        final OkHttpClient HTTP_CLIENT = new OkHttpClient().newBuilder().build();
        MediaType mediaType = MediaType.parse("application/json");
        RequestBody body = RequestBody.create(mediaType, "");
        Request request = new Request.Builder()
                .url("https://aip.baidubce.com/oauth/2.0/token?client_id=" + System.getenv("ERNIE_CLIENT_ID")
                    + "&client_secret=" + System.getenv("ERNIE_CLIENT_SECRET")
                    + "&grant_type=client_credentials")
                .method("POST", body)
                .addHeader("Content-Type", "application/json")
                .addHeader("Accept", "application/json")
                .build();
        Response response = HTTP_CLIENT.newCall(request).execute();
        JSONObject jsonObject = JSONObject.parseObject(response.body().string());
        //System.out.println(jsonObject.toJSONString());
        RedisUtil.redis.opsForValue().set("ernine_access_token",jsonObject.getString("access_token"),3600, TimeUnit.SECONDS);
        return jsonObject.getString("access_token");
    }
}
