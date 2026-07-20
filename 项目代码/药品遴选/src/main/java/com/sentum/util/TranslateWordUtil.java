package com.sentum.util;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.ATCDrugs;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import java.util.Map;

/**
 * 翻译接口，翻译用户输入的词
 * @author zgm
 */
@Slf4j
public class TranslateWordUtil {
    /**
     * 记录上次访问时间
     */
    private static long t;
    private static final String SUCCESS = "1";
    private static final String CODE = "code";
    private static final String RESULT = "result";
    /**
     * 将用户输入的中文翻译成英文
     * @param word 用户输入的词
     * @return 翻译后的结果
     */
    public static String translateChineseToEnglish(String word){
        ATCDrugs atcDrugs = MongoUtil.mongo.findOne(new Query(Criteria.where("chineseName").is(word.toLowerCase())), ATCDrugs.class);
        if (atcDrugs != null && StringUtils.isNotBlank(atcDrugs.getEnglishName())){
            return atcDrugs.getEnglishName();
        }
        log.info("请求中文翻译成英文接口");
        TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
        Map<String, String> transResultMap = tencentTranSmartApi.getTransResult(word, "zh", "en");
        if(SUCCESS.equals(transResultMap.get(CODE))){
            log.info("腾讯翻译成功==" + word + "--->" + transResultMap.get(RESULT));
            return transResultMap.get(RESULT);
        } else {
            //出错
            log.info("腾讯翻译出现错误" + transResultMap.get(CODE) + "，翻译内容：" + word);
            VerticalTransApi verticalTransApi = new VerticalTransApi();
            //请求翻译为英文
            String freeResult = verticalTransApi.getTransResult(word, "auto", "en");
            //记录请求时间
            t = System.currentTimeMillis();
            JSONObject freeJsonObj = JSON.parseObject(freeResult);
            if (freeJsonObj.containsKey("trans_result")){
                //成功
                JSONObject transResult = freeJsonObj.getJSONArray("trans_result").getJSONObject(0);
                log.info("百度垂直翻译成功==" + word + "--->" + transResult.getString("dst"));
                return transResult.getString("dst");
            }else{
                //出错
                log.info("垂直翻译出现错误" + freeJsonObj.getInteger("error_code") + "，翻译内容：" + word);
                return word;
            }
        }
    }

    /**
     * 将用户输入的英文翻译成中文
     * @param word 用户输入的词
     * @return 翻译后的结果
     */
    public static String translateEnglishToChinese(String word){
        ATCDrugs atcDrugs = MongoUtil.mongo.findOne(new Query(Criteria.where("englishName").is(word.toLowerCase())), ATCDrugs.class);
        if (atcDrugs != null && StringUtils.isNotBlank(atcDrugs.getChineseName())){
            return atcDrugs.getChineseName();
        }
        log.info("请求英文翻译成中文接口");
        TencentTranSmartApi tencentTranSmartApi = new TencentTranSmartApi();
        Map<String, String> transResultMap = tencentTranSmartApi.getTransResult(word, "en", "zh");
        if(SUCCESS.equals(transResultMap.get(CODE))){
            log.info("腾讯翻译成功==" + word + "--->" + transResultMap.get(RESULT));
            return transResultMap.get(RESULT);
        } else {
            //出错
            log.info("腾讯翻译出现错误" + transResultMap.get(CODE) + "，翻译内容：" + word);
            VerticalTransApi verticalTransApi = new VerticalTransApi();
            //请求翻译为英文
            String freeResult = verticalTransApi.getTransResult(word, "en", "zn");
            //记录请求时间
            t = System.currentTimeMillis();
            JSONObject freeJsonObj = JSON.parseObject(freeResult);
            if (freeJsonObj.containsKey("trans_result")){
                //成功
                JSONObject transResult = freeJsonObj.getJSONArray("trans_result").getJSONObject(0);
                log.info("百度垂直翻译成功==" + word + "--->" + transResult.getString("dst"));
                return transResult.getString("dst");
            }else{
                //出错
                log.info("垂直翻译出现错误" + freeJsonObj.getInteger("error_code") + "，翻译内容：" + word);
                return word;
            }
        }
    }
}
