package com.sentum.evidencecomprehensive.event;

import com.sentum.evidencecomprehensive.event.bo.PictureAnalysisBo;
import lombok.Getter;
import org.springframework.context.ApplicationEvent;

/**
 * @Description: 监听pdf 上传成功之后进行图片解析
 */
@Getter
public class PictureAnalysisEvent extends ApplicationEvent {
    private final PictureAnalysisBo pictureAnalysisBo;

    public PictureAnalysisEvent(Object source, PictureAnalysisBo pictureAnalysisBo) {
        super(source);
        this.pictureAnalysisBo = pictureAnalysisBo;
    }
}
