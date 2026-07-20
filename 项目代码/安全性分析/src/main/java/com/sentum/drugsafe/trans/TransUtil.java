package com.sentum.drugsafe.trans;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 对用户输入的词进行判断为中英文并翻译
 * @author zgm
 */
@Slf4j
public class TransUtil {
    private static long t;
    public static String getTransResult(String word){
        TransApi transApi = new TransApi(t);
        boolean judgeChinese = GetMaxSimilarUtil.judgeChinese(word);
        String transResult;
        if (judgeChinese){
            //中文翻译成英文
            transResult = transApi.getTransResult(word, "zh", "en");
        }else {
            //英文翻译成中文
            transResult = transApi.getTransResult(word, "en", "zh");
        }
        t = System.currentTimeMillis();
        JSONObject jsonObject = JSONObject.parseObject(transResult);
        if (jsonObject.containsKey("trans_result")){
            JSONObject result = jsonObject.getJSONArray("trans_result").getJSONObject(0);
            return result.getString("dst");
        }else {
            return word;
        }
    }

    public static String getTransResultJp(String word){
        TransApi transApi = new TransApi(t);
        boolean judgeChinese = GetMaxSimilarUtil.judgeChinese(word);
        String transResult;
            //中文翻译成英文
        transResult = transApi.getTransResult(word, "jp", "zh");
        t = System.currentTimeMillis();
        JSONObject jsonObject = JSONObject.parseObject(transResult);
        if (jsonObject.containsKey("trans_result")){
            JSONObject result = jsonObject.getJSONArray("trans_result").getJSONObject(0);
            return result.getString("dst");
        }else {
            return word;
        }
    }

    public static String getTransByString(String string){
        StringBuilder resultTrans = new StringBuilder();
        List<String> originList = new ArrayList<>();
        if (string.getBytes().length > 6000) {
            //内容长度超长，需要分句请求翻译后再拼接结果
            do {
                int pos = SplitTransUtils.splitTrans(string);
                //位置存在，则按结束符位置分隔，不存在，则按长度6000截取
                String split = string.substring(0, pos + 1);
                string = string.substring(pos + 1);
                originList.add(split);
            } while (string.getBytes().length > 6000);
            //添加最后一段内容
            if (string.length() > 0) {
                originList.add(string);
            }
        } else {
            originList.add(string);
        }
        for (String s : originList) {
            //逐次翻译后再拼接结果
            TransApi api = new TransApi(System.currentTimeMillis());
            //请求翻译为中文
            String result = api.getTransResult(s, "auto", "zh");
            if (result == null) {
                return s;
            }
            JSONObject jsonObj = JSON.parseObject(result);
            if (jsonObj.containsKey("trans_result")) {
                //成功
                JSONObject transResult = jsonObj.getJSONArray("trans_result").getJSONObject(0);
                resultTrans.append(transResult.getString("dst"));
            } else {
                //出错
                log.info("翻译出现错误" + jsonObj.getInteger("error_code") + "，翻译内容：" + resultTrans);
                //翻译异常之后启动腾讯翻译smart
                log.info("启动腾讯翻译...");
                TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
                Map<String, String> transResult = tencentTranSmartApi.getTransResult(s, "en", "zh");
                log.info("翻译结果为：{}", transResult);
                if ("1".equals(transResult.get("code"))){
                    return transResult.get("result");
                }
                return s;
            }
        }
        return resultTrans.toString();
    }
}
