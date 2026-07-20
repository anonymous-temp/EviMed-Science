package com.sentum.evidencecomprehensive.utils.operateyl;

import org.apache.http.HttpEntity;
import org.apache.http.NameValuePair;
import org.apache.http.client.entity.UrlEncodedFormEntity;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.message.BasicNameValuePair;
import org.apache.http.util.EntityUtils;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Map.Entry;

public class HttpUtils {

    /**
     * post 请求方式
     * @param url 请求地址
     * @param params  请求参数
     * @param charset 请求字符集
     * @return response 返回结果
     * @throws IOException 异常
     */ 
    public static String post(String url, Map<String, String> params, String charset)
            throws IOException {
        String responseEntity = "";
        // 创建CloseableHttpClient对象
        CloseableHttpClient client = HttpClients.createDefault();
        // 创建post方式请求对象
        HttpPost httpPost = new HttpPost(url);
        // 生成请求参数
        List<NameValuePair> nameValuePairs = new ArrayList<>();
        if (params != null) {
            for (Entry<String, String> entry : params.entrySet()) {
                nameValuePairs.add(new BasicNameValuePair(entry.getKey(), entry.getValue()));
            }
        }
        // 将参数添加到post请求中
        httpPost.setEntity(new UrlEncodedFormEntity(nameValuePairs, charset));
        // 发送请求，获取结果（同步阻塞）
        CloseableHttpResponse response = client.execute(httpPost);
        // 获取响应实体
        HttpEntity entity = response.getEntity();
        if (entity != null) {
            // 按指定编码转换结果实体为String类型
            responseEntity = EntityUtils.toString(entity, charset);
        }
        // 释放资源
        EntityUtils.consume(entity);
        response.close();
        return responseEntity;
    }
}