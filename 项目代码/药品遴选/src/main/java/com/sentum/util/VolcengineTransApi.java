package com.sentum.util;

import com.volcengine.model.request.TranslateTextRequest;
import com.volcengine.model.response.ResponseMetadata;
import com.volcengine.model.response.TranslateTextResponse;
import com.volcengine.service.translate.ITranslateService;
import com.volcengine.service.translate.impl.TranslateServiceImpl;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.List;

/**
 * 火山翻译api
 * @author zgm
 */
@Slf4j
public class VolcengineTransApi {
    private static final String ACCESS_KEY = System.getenv("VOLCENGINE_ACCESS_KEY_ID");
    private static final String SECRET_ACCESS_KEY = System.getenv("VOLCENGINE_ACCESS_KEY_SECRET");

    public List<String> getTransResult(List<String> textList, String target){
        List<String> resultList = new ArrayList<>();
        ITranslateService translateService = TranslateServiceImpl.getInstance();
        translateService.setAccessKey(ACCESS_KEY);
        translateService.setSecretKey(SECRET_ACCESS_KEY);
        try {
            TranslateTextRequest translateTextRequest = new TranslateTextRequest();
            // 不设置表示自动检测
            // translateTextRequest.setSourceLanguage("en");
            translateTextRequest.setTargetLanguage(target);
            translateTextRequest.setTextList(textList);
            TranslateTextRequest.Options options = new TranslateTextRequest.Options();
            //options.setCategory("medicine");
            options.setCategory("biomedical");
            translateTextRequest.setOptions(options);
            TranslateTextResponse translateText = translateService.translateText(translateTextRequest);
            List<TranslateTextResponse.Translation> translationList = translateText.getTranslationList();
            ResponseMetadata responseMetadata = translateText.getResponseMetadata();
            ResponseMetadata.Error error = responseMetadata.getError();
            if (error != null){
                String code = error.getCode();
                String message = error.getMessage();
                log.error("火山翻译异常{}，{}", code, message);
                log.info("调用认证后百度翻译进行翻译");
                for (String s : textList) {
                    resultList.add(VerticalTransUtil.getTransResult(s));
                }
            }else {
                for (TranslateTextResponse.Translation translation : translationList) {
                    //将翻译后的符号 . 去除
                    resultList.add(translation.getTranslation().replaceAll("\\.", ""));
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        return resultList;
    }
}
