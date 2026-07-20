package com.sentum.evidencecomprehensive.event;

import com.sentum.evidencecomprehensive.event.bo.AlgAnalysisBo;
import lombok.Getter;
import org.springframework.context.ApplicationEvent;

/**
 * @Description: 算法解析图片的四角坐标
 */
@Getter
public class AlgAnalysisEvent extends ApplicationEvent {
    private AlgAnalysisBo algAnalysisBo;

    public AlgAnalysisEvent(Object source, AlgAnalysisBo algAnalysisBo) {
        super(source);
        this.algAnalysisBo = algAnalysisBo;
    }
}
