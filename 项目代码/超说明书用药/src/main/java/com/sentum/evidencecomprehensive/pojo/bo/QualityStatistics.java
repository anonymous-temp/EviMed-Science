package com.sentum.evidencecomprehensive.pojo.bo;

import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.pojo.enums.PredictResultEnum;
import lombok.Getter;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

@Getter
public class QualityStatistics {
    private List<String> metaPredicts = new ArrayList<>();
    private int yesNum = 0;
    private int noNum = 0;
    private int partNum = 0;
    private int notApplicableNum = 0;
    private int otherNum = 0;

    public void addMetaPredict(String predict) {
        metaPredicts.add(predict);
    }

    public void updateEconomyStatistics(String predict) {
        PredictResultEnum predictEnum = PredictResultEnum.of(predict);
        if (Objects.nonNull(predictEnum)) {
            switch (predictEnum.getResult()) {
                case "是":
                    yesNum++;
                    break;
                case "否":
                    noNum++;
                    break;
                case "部分是":
                    partNum++;
                    break;
                case "不适用":
                    notApplicableNum++;
                    break;
            }
        } else {
            otherNum++;
        }
    }

    public String calculateMetaQuality() {
        String quality = "极低";
        int highQualityYes = 0;
        int lowQualityYes = 0;

        for (int i = 0; i < metaPredicts.size(); i++) {
            PredictResultEnum predictEnum = PredictResultEnum.of(metaPredicts.get(i));
            if (Objects.nonNull(predictEnum)) {
                String result = predictEnum.getResult();
                boolean isHighQualityTerm = Constants.META_HIGH_QUALITY_TERM.contains(i + 1);

                if ("是".equals(result) || "不适用".equals(result)) {
                    if (isHighQualityTerm) {
                        highQualityYes++;
                    } else {
                        lowQualityYes++;
                    }
                }
            }
        }

        if (highQualityYes == 7) {
            quality = lowQualityYes >= 8 ? "高" : "中";
        } else if (highQualityYes == 6) {
            quality = "低";
        }

        return quality;
    }
}
