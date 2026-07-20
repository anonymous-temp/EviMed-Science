package com.sentum.drugsafe.trans;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.feign.FineScreenFeign;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationContextAware;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 翻译接口，翻译用户输入的词
 * @author zgm
 */
@Slf4j
@Component
public class TranslateWordUtil implements ApplicationContextAware {

    @Autowired
    private FineScreenFeign fineScreenFeign;

    // 保存应用上下文引用
    private static ApplicationContext applicationContext;

    // 用于静态方法获取FineScreenFeign实例
    private static FineScreenFeign staticFineScreenFeign;

    /**
     * 设置应用上下文
     * @param applicationContext 应用上下文
     * @throws BeansException bean异常
     */
    @Override
    public void setApplicationContext(ApplicationContext applicationContext) throws BeansException {
        TranslateWordUtil.applicationContext = applicationContext;
        // 初始化静态引用
        TranslateWordUtil.staticFineScreenFeign = applicationContext.getBean(FineScreenFeign.class);
    }

    /**
     * 获取FineScreenFeign实例（供静态方法使用）
     * @return FineScreenFeign实例
     */
    private static FineScreenFeign getFineScreenFeign() {
        // 如果通过setApplicationContext初始化了，直接返回
        if (staticFineScreenFeign != null) {
            return staticFineScreenFeign;
        }
        // 否则从应用上下文获取
        return applicationContext.getBean(FineScreenFeign.class);
    }

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
    @Deprecated
    public static String translateChineseToEnglish(String word){
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
    @Deprecated
    public static String translateEnglishToChinese(String word){
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

    /**
     * 静态翻译方法，可直接调用无需传入fineScreenFeign参数
     * @param word 待翻译的词
     * @return 翻译结果
     */
    public static String translate(String word){
        String transResult = word;

        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);

        // 通过静态方法获取FineScreenFeign实例
        FineScreenFeign feign = getFineScreenFeign();
        transResult = feign.deepl(jsonObject).replaceAll("\\.", "");

        if(StrUtil.startWith(transResult,"of ") && transResult.length() > 3){
            transResult = transResult.substring(3);
        }
        return transResult;
    }

}
